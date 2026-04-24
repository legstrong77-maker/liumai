-- 六脈 LIUMAI · Hunter D1 Schema
-- 在 Cloudflare Dashboard → D1 → liumai-hunter → Console 貼上並執行

CREATE TABLE IF NOT EXISTS signals (
  key           TEXT PRIMARY KEY,     -- e.g. "2330_2026-04-24"
  code          TEXT NOT NULL,
  name          TEXT,
  fired_at      INTEGER NOT NULL,     -- unix ms
  market_open   INTEGER DEFAULT 1,
  entry         REAL NOT NULL,
  stop_loss     REAL NOT NULL,
  target        REAL NOT NULL,
  rr            REAL,
  composite     INTEGER,
  verdict       TEXT,
  trigger_msg   TEXT,
  all_signals   TEXT,                 -- JSON array
  dims          TEXT,                 -- JSON object
  sources       TEXT,                 -- JSON array
  status        TEXT NOT NULL DEFAULT 'open',   -- open | win | stop | expired
  high_seen     REAL,
  low_seen      REAL,
  last_price    REAL,
  last_check_at INTEGER,
  outcome_pct   REAL,
  closed_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_signals_status   ON signals(status);
CREATE INDEX IF NOT EXISTS idx_signals_fired_at ON signals(fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_code     ON signals(code);

CREATE TABLE IF NOT EXISTS scans (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at          INTEGER NOT NULL,
  scanned_count   INTEGER DEFAULT 0,
  fresh_count     INTEGER DEFAULT 0,
  duration_ms     INTEGER DEFAULT 0,
  error_count     INTEGER DEFAULT 0,
  market_open     INTEGER DEFAULT 0,
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_scans_ran_at ON scans(ran_at DESC);

CREATE TABLE IF NOT EXISTS universe_cache (
  date   TEXT PRIMARY KEY,     -- yyyy-mm-dd
  codes  TEXT NOT NULL          -- JSON array of stock codes
);

CREATE TABLE IF NOT EXISTS kline_cache (
  code   TEXT,
  date   TEXT,
  data   TEXT NOT NULL,         -- JSON array of candles
  PRIMARY KEY (code, date)
);
