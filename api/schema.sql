-- One row per round started. The server hands out the id; a score can only be submitted once per id.
CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  mode INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rounds_ip ON rounds(ip_hash, started_at);

-- One row per submitted score.
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  initials TEXT NOT NULL,
  mode INTEGER NOT NULL,
  strokes INTEGER NOT NULL,
  rel INTEGER NOT NULL,
  holes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ip_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_board ON scores(mode, rel, created_at);
CREATE INDEX IF NOT EXISTS idx_scores_ip ON scores(ip_hash, created_at);
