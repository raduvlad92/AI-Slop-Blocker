-- Additive migration for existing databases; does not delete existing reports.
CREATE INDEX IF NOT EXISTS idx_submission_created
  ON submissions (createdAt);
