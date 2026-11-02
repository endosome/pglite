import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { timescaledb, type PGliteWithTimescaledb } from '../src/index.js'

const MINUTE = 60 * 1000

// 30 days of 10 minute readings in 1 day chunks, with a continuous aggregate
// and compression, retention and refresh policies
const setupMetrics = async (pg: PGlite) => {
  await pg.exec(`
    CREATE TABLE metrics (ts timestamptz NOT NULL, device int, v double precision);
    SELECT create_hypertable('metrics', 'ts', chunk_time_interval => interval '1 day');
    INSERT INTO metrics
      SELECT t, d, random()
      FROM generate_series(now() - interval '30 days', now(), interval '10 min') t, generate_series(1, 3) d;
    CREATE MATERIALIZED VIEW metrics_hourly WITH (timescaledb.continuous) AS
      SELECT time_bucket('1 hour', ts) AS bucket, device, avg(v) FROM metrics GROUP BY 1, 2
      WITH NO DATA;
    ALTER TABLE metrics SET (timescaledb.compress, timescaledb.compress_segmentby = 'device');
  `)
  const jobs = await pg.query<{
    compression: number
    retention: number
    refresh: number
  }>(`
    SELECT
      add_compression_policy('metrics', interval '7 days') AS compression,
      add_retention_policy('metrics', interval '20 days') AS retention,
      add_continuous_aggregate_policy('metrics_hourly',
        start_offset => interval '40 days', end_offset => interval '1 hour',
        schedule_interval => interval '1 hour') AS refresh
  `)
  return jobs.rows[0]
}

const policyEffects = async (pg: PGlite) =>
  (
    await pg.query<{ chunks: number; compressed: number; cagg_rows: number }>(`
      SELECT
        (SELECT count(*)::int FROM show_chunks('metrics')) AS chunks,
        (SELECT count(*)::int FROM timescaledb_information.chunks
          WHERE hypertable_name = 'metrics' AND is_compressed) AS compressed,
        (SELECT count(*)::int FROM metrics_hourly) AS cagg_rows
    `)
  ).rows[0]

interface JobStats {
  last_run_status: string | null
  total_runs: number
  total_successes: number
  total_failures: number
  next_start: Date | null
}

const jobStats = async (pg: PGlite, jobId: number) =>
  (
    await pg.query<JobStats>(
      `SELECT last_run_status, total_runs::int, total_successes::int, total_failures::int, next_start
       FROM timescaledb_information.job_stats WHERE job_id = $1`,
      [jobId],
    )
  ).rows[0]

describe('timescaledb jobs', () => {
  let pg: PGlite & PGliteWithTimescaledb

  beforeEach(async () => {
    pg = await PGlite.create({ extensions: { timescaledb } })
    await pg.exec('CREATE EXTENSION IF NOT EXISTS timescaledb;')
  })
  afterEach(async () => {
    if (!pg.closed) {
      await pg.close()
    }
  })

  it('runs compression, retention and refresh policies with run_job', async () => {
    const jobs = await setupMetrics(pg)

    await pg.exec(`CALL run_job(${jobs.retention})`)
    await pg.exec(`CALL run_job(${jobs.compression})`)
    await pg.exec(`CALL run_job(${jobs.refresh})`)

    const effects = await policyEffects(pg)
    // 31 daily chunks, the 10 older than 20 days dropped
    expect(effects.chunks).toBe(21)
    // the remaining chunks older than 7 days compressed
    expect(effects.compressed).toBeGreaterThanOrEqual(13)
    expect(effects.compressed).toBeLessThanOrEqual(14)
    expect(effects.cagg_rows).toBeGreaterThan(0)

    // data in compressed chunks is still readable
    const rows = await pg.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM metrics`,
    )
    expect(rows.rows[0].count).toBeGreaterThan(0)
  })

  it('runs due jobs and records their statistics', async () => {
    const jobs = await setupMetrics(pg)

    const before = Date.now()
    const { runs, nextStart } = await pg.timescaledb.runDueJobs()

    const ran = runs.map((r) => r.jobId)
    expect(ran).toEqual(
      expect.arrayContaining([jobs.compression, jobs.retention, jobs.refresh]),
    )
    expect(runs.every((r) => r.success)).toBe(true)

    const effects = await policyEffects(pg)
    expect(effects.chunks).toBe(21)
    expect(effects.compressed).toBeGreaterThanOrEqual(13)
    expect(effects.cagg_rows).toBeGreaterThan(0)

    const refresh = await jobStats(pg, jobs.refresh)
    expect(refresh).toMatchObject({
      last_run_status: 'Success',
      total_runs: 1,
      total_successes: 1,
      total_failures: 0,
    })
    // the refresh policy runs hourly
    expect(refresh.next_start!.getTime()).toBeGreaterThanOrEqual(
      before + 59 * MINUTE,
    )
    expect(refresh.next_start!.getTime()).toBeLessThanOrEqual(
      Date.now() + 61 * MINUTE,
    )

    expect(nextStart).toBeInstanceOf(Date)
    expect(nextStart!.getTime()).toBeGreaterThan(Date.now())
  })

  it('does not run jobs that are not due', async () => {
    const jobs = await setupMetrics(pg)
    await pg.timescaledb.runDueJobs()

    const { runs } = await pg.timescaledb.runDueJobs()
    expect(runs).toEqual([])
    expect((await jobStats(pg, jobs.refresh)).total_runs).toBe(1)

    // once it is due again, it runs again
    await pg.query(
      `SELECT alter_job($1, next_start => now() - interval '1 minute')`,
      [jobs.refresh],
    )
    const again = await pg.timescaledb.runDueJobs()
    expect(again.runs.map((r) => r.jobId)).toEqual([jobs.refresh])
    expect((await jobStats(pg, jobs.refresh)).total_runs).toBe(2)
  })

  it('records failures and retries after the retry period', async () => {
    await pg.exec(`
      CREATE PROCEDURE failing_job(job_id int, config jsonb) LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'job broke' USING ERRCODE = 'P0042', DETAIL = 'some detail';
      END
      $$;
    `)
    const added = await pg.query<{ job_id: number }>(
      `SELECT add_job('failing_job', interval '1 hour') AS job_id`,
    )
    const jobId = added.rows[0].job_id
    await pg.query(
      `SELECT alter_job($1, retry_period => interval '10 minutes')`,
      [jobId],
    )

    const before = Date.now()
    const { runs } = await pg.timescaledb.runDueJobs()
    const run = runs.find((r) => r.jobId === jobId)!
    expect(run.success).toBe(false)
    expect(run.error?.message).toBe('job broke')

    const stats = await jobStats(pg, jobId)
    expect(stats).toMatchObject({
      last_run_status: 'Failed',
      total_runs: 1,
      total_successes: 0,
      total_failures: 1,
    })
    // retried after the retry period (with up to a few percent of jitter)
    const retryIn = stats.next_start!.getTime() - before
    expect(retryIn).toBeGreaterThan(5 * MINUTE)
    expect(retryIn).toBeLessThan(15 * MINUTE)

    const errors = await pg.query<{ sqlerrcode: string; err_message: string }>(
      `SELECT sqlerrcode, err_message FROM timescaledb_information.job_errors WHERE job_id = $1`,
      [jobId],
    )
    expect(errors.rows).toEqual([
      { sqlerrcode: 'P0042', err_message: 'job broke some detail' },
    ])

    // the failed job is not due again until its retry
    const again = await pg.timescaledb.runDueJobs()
    expect(again.runs.map((r) => r.jobId)).not.toContain(jobId)
  })

  it('logs job runs in the history when execution logging is enabled', async () => {
    await pg.close()
    pg = await PGlite.create({
      extensions: { timescaledb },
      startParams: [
        ...PGlite.defaultStartParams,
        '-c',
        'timescaledb.enable_job_execution_logging=on',
      ],
    })
    await pg.exec(`
      CREATE EXTENSION IF NOT EXISTS timescaledb;
      CREATE PROCEDURE ok_job(job_id int, config jsonb) LANGUAGE plpgsql AS $$ BEGIN END $$;
      CREATE PROCEDURE failing_job(job_id int, config jsonb) LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'job broke';
      END
      $$;
    `)
    const added = await pg.query<{ ok: number; failing: number }>(`
      SELECT add_job('ok_job', interval '1 hour') AS ok,
             add_job('failing_job', interval '1 hour') AS failing
    `)
    const { ok, failing } = added.rows[0]

    await pg.timescaledb.runDueJobs()

    const history = await pg.query<{
      job_id: number
      succeeded: boolean
      finished: boolean
      message: string | null
    }>(
      `SELECT job_id, succeeded, execution_finish IS NOT NULL AS finished,
              data->'error_data'->>'message' AS message
       FROM _timescaledb_internal.bgw_job_stat_history
       WHERE job_id IN ($1, $2) ORDER BY job_id`,
      [ok, failing],
    )
    // one entry per run, opened at the start and closed with the result
    expect(history.rows).toEqual([
      { job_id: ok, succeeded: true, finished: true, message: null },
      {
        job_id: failing,
        succeeded: false,
        finished: true,
        message: 'job broke',
      },
    ])
  })

  it('detects a run that never finished as a crash', async () => {
    const jobs = await setupMetrics(pg)
    await pg.timescaledb.runDueJobs()

    // what job_run_with_stats leaves behind if the page is closed while the job runs
    await pg.exec(`
      UPDATE _timescaledb_internal.bgw_job_stat
      SET last_start = now(), total_runs = total_runs + 1,
          total_crashes = total_crashes + 1, consecutive_crashes = 1, last_run_success = false
      WHERE job_id = ${jobs.refresh}
    `)

    const before = Date.now()
    const { runs } = await pg.timescaledb.runDueJobs()
    expect(runs.map((r) => r.jobId)).not.toContain(jobs.refresh)

    const crash = await pg.query<{ next_start: Date; total_crashes: number }>(
      `SELECT next_start, total_crashes::int FROM _timescaledb_internal.bgw_job_stat WHERE job_id = $1`,
      [jobs.refresh],
    )
    expect(crash.rows[0].total_crashes).toBe(1)
    // jobs wait at least 5 minutes after a crash
    expect(crash.rows[0].next_start.getTime()).toBeGreaterThanOrEqual(
      before + 5 * MINUTE - 1000,
    )

    const errors = await pg.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM timescaledb_information.job_errors WHERE job_id = $1`,
      [jobs.refresh],
    )
    expect(errors.rows[0].count).toBe(1)
  })

  it('does not run jobs while a transaction is open', async () => {
    const jobs = await setupMetrics(pg)

    await pg.exec('BEGIN')
    await pg.exec(`INSERT INTO metrics VALUES (now(), 1, 1)`)
    const { runs, deferred } = await pg.timescaledb.runDueJobs()
    expect(runs).toEqual([])
    expect(deferred).toBe(true)
    // the open transaction is untouched and can still commit
    await pg.exec('COMMIT')
    const committed = await pg.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM metrics WHERE v = 1 AND device = 1`,
    )
    expect(committed.rows[0].count).toBe(1)

    // nothing was recorded, the jobs are still due
    expect((await jobStats(pg, jobs.refresh))?.total_runs ?? 0).toBe(0)
    const after = await pg.timescaledb.runDueJobs()
    expect(after.runs.map((r) => r.jobId)).toContain(jobs.refresh)
  })

  it('refuses to run a job inside a transaction block before recording anything', async () => {
    const jobs = await setupMetrics(pg)

    await pg.exec('BEGIN')
    await expect(
      pg.exec(
        `CALL _timescaledb_functions.job_run_with_stats(${jobs.refresh})`,
      ),
    ).rejects.toMatchObject({ code: '25001' })
    await pg.exec('ROLLBACK')

    // no run was recorded: the check comes before mark_start
    expect(await jobStats(pg, jobs.refresh)).toMatchObject({
      last_run_status: null,
      total_runs: null,
    })
  })

  it('limits the number of jobs per call', async () => {
    await setupMetrics(pg)

    const first = await pg.timescaledb.runDueJobs({ maxJobs: 1 })
    expect(first.runs).toHaveLength(1)
    expect(first.nextStart!.getTime()).toBeLessThanOrEqual(Date.now())

    const rest = await pg.timescaledb.runDueJobs()
    expect(rest.runs.length).toBeGreaterThanOrEqual(3)
  })
})
