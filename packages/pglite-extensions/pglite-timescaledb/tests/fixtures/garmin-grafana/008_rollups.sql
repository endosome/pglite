-- Continuous aggregates need the Timescale Community license (timescale/timescaledb, not the -oss image).
DO $$ BEGIN
 IF current_setting('timescaledb.license', true) IS DISTINCT FROM 'timescale' THEN
  RAISE EXCEPTION 'TimescaleDB runs with the "%" license; garmin-grafana needs the Community image timescale/timescaledb:2.31.0-pg17 (not -oss)',
   current_setting('timescaledb.license', true);
 END IF;
END $$;

-- The one number each intraday dataset's long-range panels aggregate. Stress leaves out Garmin's negative
-- "not measured" codes. Materialized rows keep the old values if this changes: recreate the views then.
-- Refreshes run with an empty search_path, hence public.
CREATE FUNCTION rollup_value(dataset text, fields jsonb) RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE dataset
  WHEN 'HeartRateIntraday' THEN public.health_number(fields, 'HeartRate')
  WHEN 'StressIntraday' THEN CASE WHEN public.health_number(fields, 'stressLevel') >= 0 THEN public.health_number(fields, 'stressLevel') END
  WHEN 'BodyBatteryIntraday' THEN public.health_number(fields, 'BodyBatteryLevel')
  WHEN 'StepsIntraday' THEN public.health_number(fields, 'StepsCount')
  WHEN 'BreathingRateIntraday' THEN public.health_number(fields, 'BreathingRate')
  WHEN 'HRV_Intraday' THEN public.health_number(fields, 'hrvValue')
 END
$$;

-- Hourly UTC buckets, split by the source calendar day, so daily averages are sum(total) / sum(samples)
-- for any time zone. Real-time: rows newer than the last refresh are aggregated at query time.
CREATE MATERIALIZED VIEW samples_hourly
 WITH (timescaledb.continuous, timescaledb.materialized_only = false, timescaledb.create_group_indexes = false) AS
SELECT source_id, dataset, local_date, time_bucket(INTERVAL '1 hour', time) AS bucket,
 count(rollup_value(dataset, fields)) AS samples, sum(rollup_value(dataset, fields)) AS total,
 min(rollup_value(dataset, fields)) AS lowest, max(rollup_value(dataset, fields)) AS highest
FROM samples
WHERE dataset IN ('HeartRateIntraday', 'StressIntraday', 'BodyBatteryIntraday', 'StepsIntraday', 'BreathingRateIntraday', 'HRV_Intraday')
GROUP BY source_id, dataset, local_date, bucket
WITH NO DATA;
CREATE INDEX samples_hourly_range ON samples_hourly (source_id, dataset, bucket);

-- The GPS heatmap's ~11 m grid cells per UTC day.
CREATE MATERIALIZED VIEW gps_cells_daily
 WITH (timescaledb.continuous, timescaledb.materialized_only = false, timescaledb.create_group_indexes = false) AS
SELECT source_id, time_bucket(INTERVAL '1 day', time) AS day,
 round(health_number(fields, 'Latitude') * 10000) / 10000 AS lat, round(health_number(fields, 'Longitude') * 10000) / 10000 AS lon,
 count(*) AS points
FROM samples
WHERE dataset = 'ActivityGPS' AND health_number(fields, 'Latitude') IS NOT NULL AND health_number(fields, 'Longitude') IS NOT NULL
GROUP BY source_id, day, lat, lon
WITH NO DATA;
CREATE INDEX gps_cells_daily_range ON gps_cells_daily (source_id, day);

-- Refreshing recomputes only buckets that changed, so the whole history is in the window: backfills and
-- imports of old data are picked up within five minutes. The policies first run as soon as this commits;
-- until then queries aggregate the raw samples.
SELECT add_continuous_aggregate_policy('samples_hourly', start_offset => NULL, end_offset => INTERVAL '1 hour',
 schedule_interval => INTERVAL '5 minutes');
SELECT add_continuous_aggregate_policy('gps_cells_daily', start_offset => NULL, end_offset => INTERVAL '1 hour',
 schedule_interval => INTERVAL '5 minutes');
