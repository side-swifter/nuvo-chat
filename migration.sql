CREATE TABLE IF NOT EXISTS group_members (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  username TEXT,
  first_name TEXT NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS message_context (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  reply_to_user_id INTEGER,
  entities_json TEXT,
  PRIMARY KEY (chat_id, message_id)
);

CREATE TABLE IF NOT EXISTS challenge_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  target_user_id INTEGER NOT NULL,
  rule TEXT NOT NULL,
  photo_check TEXT,
  photo_can_complete INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_challenge_runs_target
  ON challenge_runs(chat_id, target_user_id, status);

CREATE TABLE IF NOT EXISTS photo_proofs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  explanation TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(chat_id, message_id)
);

CREATE TABLE IF NOT EXISTS scores (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);