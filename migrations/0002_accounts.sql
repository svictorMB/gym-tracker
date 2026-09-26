-- Accounts, sessions and buddies. Existing rows keep person = name and get user_id = NULL
-- until attached to an account (see README, "Attaching the old logs").
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS friendships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL,
  addressee_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(requester_id, addressee_id)
);
ALTER TABLE weights ADD COLUMN user_id INTEGER;
ALTER TABLE lifts ADD COLUMN user_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_lifts_user_ex ON lifts(user_id, exercise);
CREATE INDEX IF NOT EXISTS idx_weights_user ON weights(user_id, date);
