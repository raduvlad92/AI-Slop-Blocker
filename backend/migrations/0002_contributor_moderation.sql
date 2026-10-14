-- Apply once to an existing database, before deploying the new Worker.
-- Existing reports are preserved and default to pending. Privately backfill
-- contributorId using SHA-256('asb-contributor-v1:' + lowercase install UUID).
ALTER TABLE submissions ADD COLUMN contributorId TEXT
  CHECK (contributorId IS NULL OR
    (length(contributorId) = 64 AND contributorId NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE submissions ADD COLUMN reviewStatus TEXT NOT NULL DEFAULT 'pending'
  CHECK (reviewStatus IN ('pending', 'useful', 'false_positive'));

CREATE TABLE IF NOT EXISTS ignored_contributors (
  contributorId TEXT PRIMARY KEY NOT NULL
    CHECK (length(contributorId) = 64 AND contributorId NOT GLOB '*[^0-9a-f]*'),
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 300),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contributor_created
  ON submissions (contributorId, createdAt);
