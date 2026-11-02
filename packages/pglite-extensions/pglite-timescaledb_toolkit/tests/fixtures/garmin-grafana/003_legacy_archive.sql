-- Immutable-to-runtime copy of every legacy identity, including obsolete strength tags.
CREATE TABLE legacy_archive (
 source_id bigint NOT NULL REFERENCES sources(id), dataset text NOT NULL,
 legacy_key text NOT NULL, time timestamptz NOT NULL, nanoseconds smallint NOT NULL,
 original_time text NOT NULL, tags jsonb NOT NULL, fields jsonb NOT NULL,
 PRIMARY KEY(source_id, dataset, legacy_key)
);
CREATE INDEX legacy_archive_range ON legacy_archive(source_id,dataset,time);
