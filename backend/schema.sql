-- AI Slop Blocker — D1 schema.
-- Apply with: wrangler d1 execute aislopblocker --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  videoId TEXT,
  channelId TEXT,
  channelName TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('video', 'channel')),
  installId TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Dedupe: one submission per install per video / per channel.
-- Partial unique indexes + INSERT OR IGNORE in the Worker.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_video_per_install
  ON submissions (installId, videoId) WHERE scope = 'video';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_channel_per_install
  ON submissions (installId, channelId) WHERE scope = 'channel';

-- Rate-limit lookups (count per installId per day).
CREATE INDEX IF NOT EXISTS idx_install_created
  ON submissions (installId, createdAt);
