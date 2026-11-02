-- The TimescaleDB Toolkit ships in timescale/timescaledb-ha, not in timescale/timescaledb.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb_toolkit') THEN
  RAISE EXCEPTION 'The timescaledb_toolkit extension is not installed; garmin-grafana needs the image timescale/timescaledb-ha:pg17.11-ts2.31.0';
 END IF;
END $$;
CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;

-- Adds the sleep stage, which only hourly_medians reads; samples_hourly leaves SleepIntraday out.
CREATE OR REPLACE FUNCTION rollup_value(dataset text, fields jsonb) RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE dataset
  WHEN 'HeartRateIntraday' THEN public.health_number(fields, 'HeartRate')
  WHEN 'StressIntraday' THEN CASE WHEN public.health_number(fields, 'stressLevel') >= 0 THEN public.health_number(fields, 'stressLevel') END
  WHEN 'BodyBatteryIntraday' THEN public.health_number(fields, 'BodyBatteryLevel')
  WHEN 'StepsIntraday' THEN public.health_number(fields, 'StepsCount')
  WHEN 'BreathingRateIntraday' THEN public.health_number(fields, 'BreathingRate')
  WHEN 'HRV_Intraday' THEN public.health_number(fields, 'hrvValue')
  WHEN 'SleepIntraday' THEN public.health_number(fields, 'SleepStageLevel')
 END
$$;

-- Exact hourly medians per source. They cannot be combined across hours or sources, so panels read them only
-- for single whole UTC hours; the Source variable selects one source.
CREATE MATERIALIZED VIEW hourly_medians
 WITH (timescaledb.continuous, timescaledb.materialized_only = false, timescaledb.create_group_indexes = false) AS
SELECT source_id, dataset, time_bucket(INTERVAL '1 hour', time) AS bucket,
 percentile_cont(0.5) WITHIN GROUP (ORDER BY rollup_value(dataset, fields)) AS median
FROM samples
WHERE dataset IN ('HeartRateIntraday', 'StressIntraday', 'BodyBatteryIntraday', 'SleepIntraday')
GROUP BY source_id, dataset, bucket
WITH NO DATA;
CREATE INDEX hourly_medians_range ON hourly_medians (source_id, dataset, bucket);

-- When the watch was worn: every 2-minute slot with a heart rate reading, as a Toolkit heartbeat aggregate per
-- hour. rollup() merges any set of them and live_ranges() returns the worn periods.
CREATE MATERIALIZED VIEW wear_hourly
 WITH (timescaledb.continuous, timescaledb.materialized_only = false, timescaledb.create_group_indexes = false) AS
SELECT source_id, time_bucket(INTERVAL '1 hour', time) AS bucket,
 heartbeat_agg(date_bin(INTERVAL '2 minutes', time, TIMESTAMPTZ '2000-01-03 00:00:00+00'), time_bucket(INTERVAL '1 hour', time),
  INTERVAL '1 hour', INTERVAL '2 minutes') AS wear
FROM samples
WHERE dataset = 'HeartRateIntraday' AND health_number(fields, 'HeartRate') IS NOT NULL
GROUP BY source_id, bucket
WITH NO DATA;
CREATE INDEX wear_hourly_range ON wear_hourly (source_id, bucket);

SELECT add_continuous_aggregate_policy('hourly_medians', start_offset => NULL, end_offset => INTERVAL '1 hour',
 schedule_interval => INTERVAL '5 minutes');
SELECT add_continuous_aggregate_policy('wear_hourly', start_offset => NULL, end_offset => INTERVAL '1 hour',
 schedule_interval => INTERVAL '5 minutes');
