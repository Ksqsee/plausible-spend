-- Ad spend on days the tracker was running, so cost per contact only compares measured days.
ALTER TABLE monthly_stats ADD COLUMN ad_spend_tracked REAL NOT NULL DEFAULT 0;
