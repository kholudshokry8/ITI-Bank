CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('loan_officer','credit_officer','senior_credit_officer','head_of_consumer_credit'))
);

-- Trusted policy knowledge base
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  source_file TEXT NOT NULL,
  page INTEGER NOT NULL,
  clause_id TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  edition TEXT,
  doc_type TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  status TEXT NOT NULL,
  embedding TEXT NOT NULL,
  embedding_model TEXT NOT NULL
);

CREATE TABLE documents (
  file TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  chunks INTEGER NOT NULL,
  error TEXT,
  ingested_at TEXT NOT NULL
);

-- Untrusted customer input: a separate table, never searched as policy
CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  source_file TEXT NOT NULL,
  pack_text TEXT NOT NULL,
  loaded_at TEXT NOT NULL
);

CREATE TABLE assessments (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  prepared_by TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  recommended_amount REAL,
  approval_required_from TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_approval','approved','rejected','issued')),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id TEXT NOT NULL REFERENCES assessments(id),
  action TEXT NOT NULL CHECK (action IN ('approve','reject','issue')),
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  comment TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
