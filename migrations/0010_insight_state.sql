-- Opportunities ticked off ("done") or hidden in the dashboard. The key ignores numbers in the
-- title, so an item keeps its state when its amounts change.
CREATE TABLE IF NOT EXISTS insight_state (
  key TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  at INTEGER NOT NULL
);
