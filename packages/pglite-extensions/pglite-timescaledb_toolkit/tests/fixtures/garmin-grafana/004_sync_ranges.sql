-- Register requested coverage before fetching; a failed oldest day must remain visible.
CREATE TABLE sync_ranges (
 source_id bigint NOT NULL REFERENCES sources(id), dataset text NOT NULL,
 start_day date NOT NULL, PRIMARY KEY(source_id, dataset)
);
INSERT INTO sync_ranges SELECT source_id,dataset,min(day) FROM sync_days GROUP BY source_id,dataset;
