CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE TABLE persons (id text PRIMARY KEY);
CREATE TABLE sources (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 provider text NOT NULL, account text NOT NULL,
 person_id text NOT NULL REFERENCES persons(id), UNIQUE(provider, account)
);
CREATE TABLE devices (
 source_id bigint NOT NULL REFERENCES sources(id), id text NOT NULL,
 PRIMARY KEY(source_id, id)
);
CREATE TABLE records (
 source_id bigint NOT NULL REFERENCES sources(id), dataset text NOT NULL,
 record_key text NOT NULL, time timestamptz NOT NULL,
 nanoseconds smallint NOT NULL CHECK (nanoseconds BETWEEN 0 AND 999),
 original_time text NOT NULL, device_id text NOT NULL,
 local_date date, timezone text,
 tags jsonb NOT NULL, fields jsonb NOT NULL,
 PRIMARY KEY(source_id, dataset, record_key)
);
CREATE TABLE samples (LIKE records INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE samples ADD PRIMARY KEY(source_id, dataset, record_key, time, nanoseconds);
SELECT create_hypertable('samples', 'time', chunk_time_interval => INTERVAL '7 days');
CREATE INDEX records_range ON records (source_id, dataset, time DESC);
CREATE INDEX samples_range ON samples (source_id, dataset, time DESC);
CREATE INDEX records_activity ON records (source_id, dataset, (tags->>'ActivityID'));
CREATE TABLE sync_days (
 source_id bigint NOT NULL REFERENCES sources(id), dataset text NOT NULL,
 day date NOT NULL, completed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(source_id, dataset, day)
);
CREATE VIEW all_records AS SELECT * FROM records UNION ALL SELECT * FROM samples;
CREATE TABLE legacy_progress (
 source_id bigint NOT NULL REFERENCES sources(id), migration_id text NOT NULL,
 measurement text NOT NULL, next_ns numeric(30,0) NOT NULL,
 imported bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(source_id, migration_id, measurement)
);
