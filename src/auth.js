// Accounts, password hashing, sessions and login throttling.
//
// Passwords are stored as PBKDF2-SHA256 hashes with a per-user salt. A login sets an HttpOnly,
// SameSite=Strict session cookie; the database only keeps a SHA-256 of the session token.

const PBKDF2_ITERATIONS = 100000 // the Workers runtime does not allow more
const SESSION_DAYS = 30
const COOKIE = 'gw_session'
// a username is locked after 5 wrong passwords; an IP only after 20, since a whole office shares one
const MAX_FAILURES = { user: 5, ip: 20 }
const FAILURE_WINDOW_MS = 15 * 60 * 1000
const LOCK_MS = 15 * 60 * 1000
export const MIN_PASSWORD_LENGTH = 12

const enc = new TextEncoder()
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)))

function randomHex(bytes) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)))
}

async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)))
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

async function pbkdf2(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations }, key, 256)
  return new Uint8Array(bits)
}

export async function hashPassword(password) {
  const salt = randomHex(16)
  return { pw_salt: salt, pw_iter: PBKDF2_ITERATIONS, pw_hash: toHex(await pbkdf2(password, salt, PBKDF2_ITERATIONS)) }
}

async function verifyPassword(password, user) {
  return equalBytes(await pbkdf2(password, user.pw_salt, user.pw_iter), fromHex(user.pw_hash))
}

// A readable but strong password: 4 groups of 4 from an alphabet without look-alikes (~80 bits).
export function generatePassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const out = []
  const bytes = crypto.getRandomValues(new Uint8Array(64))
  let i = 0
  for (let g = 0; g < 4; g++) {
    let part = ''
    while (part.length < 4) {
      const b = bytes[i++]
      // rejection sampling keeps every character equally likely
      if (b < 220) part += alphabet[b % alphabet.length]
    }
    out.push(part)
  }
  return out.join('-')
}

// The first admin is created from the old shared dashboard password, so nobody has to send a new one around.
export async function ensureAdmin(env) {
  const row = await env.DB.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first()
  if (row || !env.DASHBOARD_PASSWORD) return
  const h = await hashPassword(env.DASHBOARD_PASSWORD)
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (username, role, company, pw_hash, pw_salt, pw_iter, created_at) VALUES ('admin', 'admin', NULL, ?, ?, ?, ?)"
  )
    .bind(h.pw_hash, h.pw_salt, h.pw_iter, Date.now())
    .run()
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || ''
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

export async function currentUser(request, env) {
  const token = readCookie(request, COOKIE)
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.role, u.company, u.disabled, s.expires_at
     FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
  )
    .bind(await sha256Hex(token))
    .first()
  if (!row || row.disabled || row.expires_at < Date.now()) return null
  return { id: row.id, username: row.username, role: row.role, company: row.company }
}

function clientKey(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown'
}

async function lockedUntil(db, key) {
  const row = await db.prepare('SELECT locked_until FROM login_attempts WHERE key = ?').bind(key).first()
  return row && row.locked_until > Date.now() ? row.locked_until : 0
}

async function recordFailure(db, key) {
  const now = Date.now()
  const row = await db.prepare('SELECT count, first_at FROM login_attempts WHERE key = ?').bind(key).first()
  const fresh = !row || now - row.first_at > FAILURE_WINDOW_MS
  const count = fresh ? 1 : row.count + 1
  await db
    .prepare(
      `INSERT INTO login_attempts (key, count, first_at, locked_until) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET count = excluded.count, first_at = excluded.first_at, locked_until = excluded.locked_until`
    )
    .bind(key, count, fresh ? now : row.first_at, count >= MAX_FAILURES[key.startsWith('ip:') ? 'ip' : 'user'] ? now + LOCK_MS : 0)
    .run()
}

// Returns { user, cookie } on success or { error } with a message that does not reveal which part was wrong.
export async function login(request, env, username, password) {
  const db = env.DB
  const name = String(username || '').trim().toLowerCase().slice(0, 64)
  const keys = ['ip:' + (await sha256Hex(clientKey(request))), 'user:' + name]
  for (const k of keys) {
    const until = await lockedUntil(db, k)
    if (until) return { error: 'Zu viele Versuche. Bitte in ' + Math.ceil((until - Date.now()) / 60000) + ' Minuten erneut versuchen.', status: 429 }
  }
  const user = await db.prepare('SELECT * FROM users WHERE username = ?').bind(name).first()
  // hash even for unknown users so response time does not reveal which usernames exist
  const ok = user ? await verifyPassword(String(password || ''), user) : (await pbkdf2(String(password || ''), '00'.repeat(16), PBKDF2_ITERATIONS), false)
  if (!ok || user.disabled) {
    for (const k of keys) await recordFailure(db, k)
    return { error: 'Benutzername oder Passwort ist falsch.', status: 401 }
  }
  await db.prepare('DELETE FROM login_attempts WHERE key IN (?, ?)').bind(...keys).run()
  const token = randomHex(32)
  const now = Date.now()
  await db.batch([
    db.prepare('INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256Hex(token), user.id, now, now + SESSION_DAYS * 86400000),
    db.prepare('UPDATE users SET last_login = ? WHERE id = ?').bind(now, user.id),
    db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').bind(now)
  ])
  return { user, cookie: `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}` }
}

export async function logout(request, env) {
  const token = readCookie(request, COOKIE)
  if (token && /^[0-9a-f]{64}$/.test(token)) {
    await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run()
  }
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
}

export async function setPassword(env, userId, password) {
  const h = await hashPassword(password)
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ?, disabled = 0 WHERE id = ?').bind(h.pw_hash, h.pw_salt, h.pw_iter, userId),
    // a new password signs out every device that used the old one
    env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?').bind(userId)
  ])
}

export async function checkPassword(env, userId, password) {
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first()
  return !!user && (await verifyPassword(String(password || ''), user))
}
