-- AI Slop Blocker — D1 schema.
-- Apply with: wrangler d1 execute aislopblocker --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  videoId TEXT,
  channelId TEXT,
  channelName TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('video', 'channel')),
  installId TEXT NOT NULL,
  contributorId TEXT CHECK (contributorId IS NULL OR
    (length(contributorId) = 64 AND contributorId NOT GLOB '*[^0-9a-f]*')),
  reviewStatus TEXT NOT NULL DEFAULT 'pending'
    CHECK (reviewStatus IN ('pending', 'useful', 'false_positive')),
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Minimal moderation registry; intentionally survives raw-report expiry.
CREATE TABLE IF NOT EXISTS ignored_contributors (
  contributorId TEXT PRIMARY KEY NOT NULL
    CHECK (length(contributorId) = 64 AND contributorId NOT GLOB '*[^0-9a-f]*'),
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 300),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
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

-- Daily deletion of raw reports older than 90 days.
CREATE INDEX IF NOT EXISTS idx_submission_created
  ON submissions (createdAt);

CREATE INDEX IF NOT EXISTS idx_contributor_created
  ON submissions (contributorId, createdAt);
