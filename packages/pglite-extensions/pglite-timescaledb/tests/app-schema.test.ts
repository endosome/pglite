import { readFileSync, readdirSync } from 'fs'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { pgDump } from '@electric-sql/pglite-tools'
import { timescaledb, type PGliteWithTimescaledb } from '../src/index.js'

// The TimescaleDB features garmin-grafana relies on, exercised with its own
// migrations (tests/fixtures/garmin-grafana, copied from its commit 64988a8):
// - the samples hypertable in 7-day chunks, and chunk exclusion for time ranges,
//   including the batched upsert bounded to the batch's time range
// - the real-time continuous aggregates samples_hourly and gps_cells_daily
// - their refresh policies, paused with alter_job and refreshed by hand in tests
// - time_bucket
// - backup and restore with pg_dump and timescaledb_pre_restore/post_restore

const fixtures = new URL('./fixtures/garmin-grafana/', import.meta.url)
const migrations = readdirSync(fixtures)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(new URL(name, fixtures), 'utf8'))

type PG = PGlite & PGliteWithTimescaledb

// Like garmin-grafana's migrate(): all migrations in one transaction
const migrate = async (pg: PG) => {
  await pg.exec('CREATE EXTENSION IF NOT EXISTS timescaledb')
  await pg.transaction(async (tx) => {
    for (const sql of migrations) {
      await tx.exec(sql)
    }
  })
}

const HOUR = 60 * 60 * 1000

// samples rows: one per minute for `minutes`, from `start`
const insertSamples = (
  pg: PG,
  {
    dataset,
    start,
    minutes,
    fields,
    key = dataset,
  }: {
    dataset: string
    start: string
    minutes: number
    fields: string
    key?: string
  },
) =>
  pg.exec(`
    INSERT INTO samples (source_id, dataset, record_key, time, nanoseconds, original_time, device_id,
                         local_date, timezone, tags, fields)
    SELECT 1, '${dataset}', '${key}:' || i, t, 0, t::text, 'd',
           (t AT TIME ZONE 'Europe/Berlin')::date, 'Europe/Berlin', '{}', ${fields}
    FROM generate_series(0, ${minutes - 1}) i,
         LATERAL (SELECT '${start}'::timestamptz + make_interval(mins => i) AS t) x
  `)

const seedSource = (pg: PG) =>
  pg.exec(`
    INSERT INTO persons VALUES ('p');
    INSERT INTO sources (provider, account, person_id) VALUES ('garmin', 'a', 'p');
    INSERT INTO devices VALUES (1, 'd');
  `)

const refreshRollups = async (pg: PG) => {
  for (const view of ['samples_hourly', 'gps_cells_daily']) {
    await pg.exec(`CALL refresh_continuous_aggregate('${view}', NULL, NULL)`)
  }
}

const count = async (pg: PG, sql: string, params: any[] = []) =>
  (await pg.query<{ n: number }>(`SELECT (${sql})::int AS n`, params)).rows[0].n

describe('garmin-grafana schema', () => {
  let pg: PG

  beforeEach(async () => {
    pg = await PGlite.create({ extensions: { timescaledb } })
    await migrate(pg)
    await seedSource(pg)
  })
  afterEach(async () => {
    if (!pg.closed) {
      await pg.close()
    }
  })

  it('applies all migrations, including the license check for continuous aggregates', async () => {
    const license = await pg.query<{ license: string }>(
      `SELECT current_setting('timescaledb.license') AS license`,
    )
    expect(license.rows[0].license).toBe('timescale')

    const hypertables = await pg.query<{ hypertable_name: string }>(
      `SELECT hypertable_name FROM timescaledb_information.hypertables ORDER BY 1`,
    )
    expect(hypertables.rows.map((r) => r.hypertable_name)).toContain('samples')

    const caggs = await pg.query<{
      view_name: string
      materialized_only: boolean
    }>(
      `SELECT view_name, materialized_only FROM timescaledb_information.continuous_aggregates ORDER BY 1`,
    )
    expect(caggs.rows).toEqual([
      { view_name: 'gps_cells_daily', materialized_only: false },
      { view_name: 'samples_hourly', materialized_only: false },
    ])
  })

  it('stores samples in 7-day chunks and excludes chunks outside a time range', async () => {
    // 4 weeks of heart rate
    await insertSamples(pg, {
      dataset: 'HeartRateIntraday',
      start: '2024-01-01T00:00:00Z',
      minutes: 4 * 7 * 24 * 60,
      fields: `jsonb_build_object('HeartRate', 60 + i % 40)`,
    })
    expect(await count(pg, `SELECT count(*) FROM show_chunks('samples')`)).toBe(
      5,
    )

    const plan = await pg.query<{ 'QUERY PLAN': string }>(`
      EXPLAIN SELECT time_bucket('1 day', time), avg(health_number(fields, 'HeartRate'))
      FROM samples
      WHERE source_id = 1 AND dataset = 'HeartRateIntraday'
        AND time >= '2024-01-02' AND time < '2024-01-03'
      GROUP BY 1`)
    const chunks = new Set(
      plan.rows.flatMap(
        (r) => r['QUERY PLAN'].match(/_hyper_\d+_\d+_chunk/g) ?? [],
      ),
    )
    expect(chunks.size).toBe(1)
  })

  it('upserts a batch in one statement bounded to its time range', async () => {
    await insertSamples(pg, {
      dataset: 'HeartRateIntraday',
      start: '2024-01-01T00:00:00Z',
      minutes: 8 * 7 * 24 * 60,
      fields: `jsonb_build_object('HeartRate', 60)`,
    })

    // storage.py PostgresStore._batch for the samples table
    const upsert = `
      INSERT INTO samples AS t (source_id,dataset,record_key,time,nanoseconds,original_time,device_id,local_date,timezone,tags,fields)
      SELECT * FROM unnest($1::bigint[],$2::text[],$3::text[],$4::timestamptz[],$5::smallint[],$6::text[],$7::text[],
          $8::date[],$9::text[],$10::jsonb[],$11::jsonb[])
          v(source_id,dataset,record_key,time,nanoseconds,original_time,device_id,local_date,timezone,tags,fields)
      WHERE NOT EXISTS (SELECT 1 FROM samples e WHERE e.source_id=v.source_id AND e.dataset=v.dataset
          AND e.record_key=v.record_key AND e.time=v.time AND e.nanoseconds=v.nanoseconds
          AND e.time BETWEEN $12 AND $13
          AND (e.time,e.nanoseconds,e.original_time,e.local_date,e.timezone,e.tags,e.fields) IS NOT DISTINCT FROM
              (v.time,v.nanoseconds,v.original_time,COALESCE(v.local_date,e.local_date),
               COALESCE(v.timezone,e.timezone),v.tags,e.fields || v.fields))
      ON CONFLICT (source_id,dataset,record_key,time,nanoseconds) DO UPDATE SET
      time=excluded.time,nanoseconds=excluded.nanoseconds,original_time=excluded.original_time,
      local_date=COALESCE(excluded.local_date,t.local_date),
      timezone=COALESCE(excluded.timezone,t.timezone),
      tags=excluded.tags,fields=t.fields || excluded.fields`

    const existing = await pg.query<{
      record_key: string
      time: Date
      original_time: string
      local_date: string
    }>(
      `SELECT record_key, time, original_time, local_date::text FROM samples
       WHERE dataset = 'HeartRateIntraday' AND time >= '2024-01-10' ORDER BY time LIMIT 2`,
    )
    const [unchanged, updated] = existing.rows
    const times = [
      unchanged.time,
      updated.time,
      new Date('2024-01-10T12:00:00Z'),
    ]
    const params = [
      [1, 1, 1],
      ['HeartRateIntraday', 'HeartRateIntraday', 'HeartRateIntraday'],
      [unchanged.record_key, updated.record_key, 'new'],
      times,
      [0, 0, 0],
      [unchanged.original_time, updated.original_time, 'new'],
      ['d', 'd', 'd'],
      // the update keeps the stored local_date when the batch has none
      [unchanged.local_date, null, '2024-01-10'],
      ['Europe/Berlin', null, 'Europe/Berlin'],
      [{}, {}, {}],
      [{ HeartRate: 60 }, { RestingHeartRate: 50 }, { HeartRate: 70 }],
      new Date(Math.min(...times.map(Number))),
      new Date(Math.max(...times.map(Number))),
    ]

    const xmin = async (key: string) =>
      (
        await pg.query<{ xmin: string }>(
          `SELECT xmin::text FROM samples WHERE record_key = $1`,
          [key],
        )
      ).rows[0].xmin
    const unchangedXmin = await xmin(unchanged.record_key)

    const result = await pg.query(upsert, params)
    // the unchanged row is filtered out before ON CONFLICT
    expect(result.affectedRows).toBe(2)
    expect(await xmin(unchanged.record_key)).toBe(unchangedXmin)

    const rows = await pg.query<{
      record_key: string
      local_date: string
      timezone: string
      fields: object
    }>(
      `SELECT record_key, local_date::text, timezone, fields FROM samples
       WHERE record_key = ANY($1) ORDER BY time`,
      [[updated.record_key, 'new']],
    )
    expect(rows.rows).toEqual([
      {
        record_key: updated.record_key,
        local_date: updated.local_date,
        timezone: 'Europe/Berlin',
        fields: { HeartRate: 60, RestingHeartRate: 50 },
      },
      {
        record_key: 'new',
        local_date: '2024-01-10',
        timezone: 'Europe/Berlin',
        fields: { HeartRate: 70 },
      },
    ])

    // the time bound keeps the existence check to the batch's chunks
    await pg.exec('BEGIN')
    const plan = await pg.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${upsert}`,
      params,
    )
    await pg.exec('ROLLBACK')
    const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n')
    const scanned = new Set(text.match(/_hyper_\d+_\d+_chunk/g) ?? [])
    const total = await count(pg, `SELECT count(*) FROM show_chunks('samples')`)
    expect(total).toBe(9)
    expect(scanned.size).toBeLessThanOrEqual(2)
  })

  it('aggregates samples_hourly in real time and materializes it on refresh', async () => {
    const hour = '2024-03-01T10:00:00Z'
    await insertSamples(pg, {
      dataset: 'HeartRateIntraday',
      start: hour,
      minutes: 60,
      fields: `jsonb_build_object('HeartRate', 60 + i)`,
    })
    // negative stress values are "not measured" and left out
    await insertSamples(pg, {
      dataset: 'StressIntraday',
      start: hour,
      minutes: 60,
      fields: `jsonb_build_object('stressLevel', CASE WHEN i < 10 THEN -1 ELSE i END)`,
    })

    const bucket = (dataset: string) =>
      pg.query<{
        samples: number
        total: number
        lowest: number
        highest: number
      }>(
        `SELECT samples::int, total, lowest, highest FROM samples_hourly
         WHERE source_id = 1 AND dataset = $1 AND bucket = $2`,
        [dataset, hour],
      )
    // before any refresh: aggregated from the raw samples at query time
    const expectedHr = {
      samples: 60,
      total: 60 * 60 + 1770,
      lowest: 60,
      highest: 119,
    }
    expect((await bucket('HeartRateIntraday')).rows).toEqual([expectedHr])
    expect((await bucket('StressIntraday')).rows).toEqual([
      { samples: 50, total: 1725, lowest: 10, highest: 59 },
    ])

    await refreshRollups(pg)
    expect((await bucket('HeartRateIntraday')).rows).toEqual([expectedHr])

    // only materialized rows: the same hour is there after the refresh
    await pg.exec(
      `ALTER MATERIALIZED VIEW samples_hourly SET (timescaledb.materialized_only = true)`,
    )
    expect((await bucket('HeartRateIntraday')).rows).toEqual([expectedHr])

    // a newer hour after the watermark is only visible in real-time mode
    const later = new Date(Date.now() + 24 * HOUR)
    later.setUTCMinutes(0, 0, 0)
    await insertSamples(pg, {
      dataset: 'HeartRateIntraday',
      start: later.toISOString(),
      minutes: 30,
      fields: `jsonb_build_object('HeartRate', 70)`,
      key: 'later',
    })
    const laterBucket = () =>
      pg.query<{ samples: number }>(
        `SELECT samples::int FROM samples_hourly WHERE dataset = 'HeartRateIntraday' AND bucket = $1`,
        [later],
      )
    expect((await laterBucket()).rows).toEqual([])
    await pg.exec(
      `ALTER MATERIALIZED VIEW samples_hourly SET (timescaledb.materialized_only = false)`,
    )
    expect((await laterBucket()).rows).toEqual([{ samples: 30 }])

    // a backfill into an hour that is already materialized shows after the next refresh
    await insertSamples(pg, {
      dataset: 'HeartRateIntraday',
      start: '2024-03-01T10:00:30Z',
      minutes: 10,
      fields: `jsonb_build_object('HeartRate', 200)`,
      key: 'backfill',
    })
    expect((await bucket('HeartRateIntraday')).rows[0].samples).toBe(60)
    await refreshRollups(pg)
    expect((await bucket('HeartRateIntraday')).rows[0]).toMatchObject({
      samples: 70,
      highest: 200,
    })
  })

  it('aggregates GPS points into daily grid cells', async () => {
    await insertSamples(pg, {
      dataset: 'ActivityGPS',
      start: '2024-03-01T08:00:00Z',
      minutes: 30,
      fields: `jsonb_build_object('Latitude', 51.50001 + (i % 2) * 0.1, 'Longitude', -0.10001)`,
    })
    // points without a position are left out
    await insertSamples(pg, {
      dataset: 'ActivityGPS',
      start: '2024-03-01T09:00:00Z',
      minutes: 5,
      fields: `jsonb_build_object('Latitude', 'n/a')`,
      key: 'nopos',
    })
    await refreshRollups(pg)

    const cells = await pg.query<{
      day: Date
      lat: number
      lon: number
      points: number
    }>(`SELECT day, lat, lon, points::int FROM gps_cells_daily ORDER BY lat`)
    expect(cells.rows).toEqual([
      {
        day: new Date('2024-03-01T00:00:00Z'),
        lat: 51.5,
        lon: -0.1,
        points: 15,
      },
      {
        day: new Date('2024-03-01T00:00:00Z'),
        lat: 51.6,
        lon: -0.1,
        points: 15,
      },
    ])
  })

  it('runs the refresh policies every 5 minutes, unless they are paused', async () => {
    const jobs = await pg.query<{
      job_id: number
      start_offset: unknown
      schedule_interval: string
    }>(`
      SELECT job_id, config->'start_offset' AS start_offset, schedule_interval
      FROM timescaledb_information.jobs
      WHERE proc_name = 'policy_refresh_continuous_aggregate' ORDER BY job_id`)
    expect(jobs.rows).toHaveLength(2)
    for (const job of jobs.rows) {
      expect(job.start_offset).toBeNull()
      expect(job.schedule_interval).toBe('00:05:00')
    }
    const jobIds = jobs.rows.map((j) => j.job_id)

    await insertSamples(pg, {
      dataset: 'HeartRateIntraday',
      start: '2024-03-01T10:00:00Z',
      minutes: 60,
      fields: `jsonb_build_object('HeartRate', 60)`,
    })
    const materializedRows = () =>
      count(
        pg,
        `SELECT count(*) FROM samples_hourly WHERE bucket < now() - interval '1 day'`,
      )

    // the policies first run right away and materialize the history
    const first = await pg.timescaledb.runDueJobs()
    expect(first.runs.filter((r) => jobIds.includes(r.jobId))).toEqual(
      jobIds.map((jobId) => expect.objectContaining({ jobId, success: true })),
    )
    await pg.exec(
      `ALTER MATERIALIZED VIEW samples_hourly SET (timescaledb.materialized_only = true)`,
    )
    expect(await materializedRows()).toBe(1)

    // next run 5 minutes later
    const stats = await pg.query<{ next_start: Date; last_run_status: string }>(
      `SELECT next_start, last_run_status FROM timescaledb_information.job_stats WHERE job_id = ANY($1)`,
      [jobIds],
    )
    for (const s of stats.rows) {
      expect(s.last_run_status).toBe('Success')
      const inMs = s.next_start.getTime() - Date.now()
      expect(inMs).toBeGreaterThan(3 * 60 * 1000)
      expect(inMs).toBeLessThanOrEqual(5 * 60 * 1000)
    }

    // paused like garmin-grafana's tests do: not run even when overdue
    await pg.exec(`
      SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs
      WHERE proc_name = 'policy_refresh_continuous_aggregate'`)
    await pg.query(
      `SELECT alter_job(id, next_start => now() - interval '1 minute') FROM unnest($1::int[]) id`,
      [jobIds],
    )
    await insertSamples(pg, {
      dataset: 'HeartRateIntraday',
      start: '2024-03-02T10:00:00Z',
      minutes: 60,
      fields: `jsonb_build_object('HeartRate', 60)`,
      key: 'next-day',
    })
    const paused = await pg.timescaledb.runDueJobs()
    expect(
      paused.runs.map((r) => r.jobId).filter((id) => jobIds.includes(id)),
    ).toEqual([])
    expect(await materializedRows()).toBe(1)

    // refreshed by hand instead
    await refreshRollups(pg)
    expect(await materializedRows()).toBe(2)
  })

  it('restores a pg_dump with continuous aggregates and their policies', async () => {
    await insertSamples(pg, {
      dataset: 'HeartRateIntraday',
      start: '2024-03-01T10:00:00Z',
      minutes: 120,
      fields: `jsonb_build_object('HeartRate', 60 + i % 10)`,
    })
    await refreshRollups(pg)
    const dump = await (await pgDump({ pg })).text()

    const restored = (await PGlite.create({
      extensions: { timescaledb },
    })) as PG
    try {
      await restored.exec('CREATE EXTENSION IF NOT EXISTS timescaledb')
      await restored.query('SELECT timescaledb_pre_restore()')
      await restored.exec(dump)
      // the dump sets search_path to '', which persists in PGlite's single session
      await restored.exec('RESET search_path')
      await restored.query('SELECT timescaledb_post_restore()')

      const summary = async (db: PG) =>
        (
          await db.query(`
            SELECT
              (SELECT count(*)::int FROM samples) AS samples,
              (SELECT count(*)::int FROM show_chunks('samples')) AS chunks,
              (SELECT json_agg(h ORDER BY bucket) FROM (SELECT bucket, samples, total FROM samples_hourly) h) AS hourly,
              (SELECT count(*)::int FROM timescaledb_information.jobs
                WHERE proc_name = 'policy_refresh_continuous_aggregate') AS policies,
              current_setting('timescaledb.restoring') AS restoring`)
        ).rows[0]
      expect(await summary(restored)).toEqual(await summary(pg))

      // the restored policies run
      const { runs } = await restored.timescaledb.runDueJobs()
      expect(runs.length).toBeGreaterThanOrEqual(2)
      expect(runs.every((r) => r.success)).toBe(true)
    } finally {
      await restored.close()
    }
  })

  it('round-trips through dumpDataDir/loadDataDir', async () => {
    await insertSamples(pg, {
      dataset: 'HeartRateIntraday',
      start: '2024-03-01T10:00:00Z',
      minutes: 60,
      fields: `jsonb_build_object('HeartRate', 60)`,
    })
    await refreshRollups(pg)
    const archive = await pg.dumpDataDir('gzip')
    const copy = (await PGlite.create({
      extensions: { timescaledb },
      loadDataDir: archive,
    })) as PG
    try {
      expect(await count(copy, `SELECT count(*) FROM samples`)).toBe(60)
      expect(await count(copy, `SELECT count(*) FROM samples_hourly`)).toBe(1)
    } finally {
      await copy.close()
    }
  })
})
