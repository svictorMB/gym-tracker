-- Original tables (safe to re-run on the existing database)
CREATE TABLE IF NOT EXISTS weights (id INTEGER PRIMARY KEY AUTOINCREMENT, person TEXT NOT NULL, date TEXT NOT NULL, lbs REAL NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS lifts (id INTEGER PRIMARY KEY AUTOINCREMENT, person TEXT NOT NULL, date TEXT NOT NULL, workout TEXT NOT NULL, exercise TEXT NOT NULL, weight REAL NOT NULL, reps INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_lifts_person_ex ON lifts(person, exercise);
CREATE INDEX IF NOT EXISTS idx_weights_person ON weights(person, date);
