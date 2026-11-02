import { readFileSync, readdirSync } from 'fs'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { pgDump } from '@electric-sql/pglite-tools'
import {
  timescaledb,
  type PGliteWithTimescaledb,
} from '@electric-sql/pglite-timescaledb'
import { timescaledb_toolkit } from '../src/index.js'

// garmin-grafana's migrations (tests/fixtures/garmin-grafana, from its commit 4d7877d), including
// 009_toolkit_rollups.sql: the wear_hourly continuous aggregate of heartbeat_agg values, which its
// dashboard merges with rollup() and turns into worn periods with live_ranges(). The expected
// results are those of timescale/timescaledb-ha (TimescaleDB 2.31.0, Toolkit 1.26.0) for the
// same migrations and data.

const fixtures = new URL('./fixtures/garmin-grafana/', import.meta.url)
const migrations = readdirSync(fixtures)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(new URL(name, fixtures), 'utf8'))

type PG = PGlite & PGliteWithTimescaledb

const extensions = { timescaledb, timescaledb_toolkit }

const migrate = async (pg: PG) => {
  await pg.exec('CREATE EXTENSION IF NOT EXISTS timescaledb')
  await pg.transaction(async (tx) => {
    for (const sql of migrations) {
      await tx.exec(sql)
    }
  })
}

// heart rate worn 00:00-00:29, 01:10-02:19 and 02:27-02:59, and 04:15-04:40 every 30 seconds
const seed = `
  INSERT INTO persons VALUES ('p');
  INSERT INTO sources (provider, account, person_id) VALUES ('garmin', 'a', 'p');
  INSERT INTO devices VALUES (1, 'd');
  INSERT INTO samples (source_id, dataset, record_key, time, nanoseconds, original_time, device_id,
                       local_date, timezone, tags, fields)
  SELECT 1, 'HeartRateIntraday', 'k' || extract(epoch FROM t), t, 0, t::text, 'd', t::date, 'UTC', '{}',
         jsonb_build_object('HeartRate', 60)
  FROM (
    SELECT generate_series('2024-03-01 00:00+00'::timestamptz, '2024-03-01 00:29+00', interval '1 minute') t
    UNION ALL SELECT generate_series('2024-03-01 01:10+00'::timestamptz, '2024-03-01 02:19+00', interval '1 minute')
    UNION ALL SELECT generate_series('2024-03-01 02:27+00'::timestamptz, '2024-03-01 02:59+00', interval '1 minute')
    UNION ALL SELECT generate_series('2024-03-01 04:15+00'::timestamptz, '2024-03-01 04:40+00', interval '30 seconds')
  ) x;
`

const refresh = async (pg: PG) => {
  for (const view of ['wear_hourly', 'hourly_medians']) {
    await pg.exec(`CALL refresh_continuous_aggregate('${view}', NULL, NULL)`)
  }
}

const rows = async <T>(pg: PG, sql: string) => (await pg.query<T>(sql)).rows

const wornRanges = [
  { start: '2024-03-01 00:00:00+00', end: '2024-03-01 00:30:00+00' },
  { start: '2024-03-01 01:10:00+00', end: '2024-03-01 02:20:00+00' },
  { start: '2024-03-01 02:26:00+00', end: '2024-03-01 03:00:00+00' },
  { start: '2024-03-01 04:14:00+00', end: '2024-03-01 04:42:00+00' },
]

const liveRanges = (pg: PG) =>
  rows<{ start: string; end: string }>(
    pg,
    `SELECT start::text, "end"::text
     FROM live_ranges((SELECT rollup(wear) FROM wear_hourly)) ORDER BY start`,
  )

describe('timescaledb_toolkit', () => {
  let pg: PG

  beforeEach(async () => {
    pg = (await PGlite.create({ extensions })) as PG
    await migrate(pg)
    await pg.exec(seed)
  })
  afterEach(async () => {
    if (!pg.closed) {
      await pg.close()
    }
  })

  it('installs the extension with garmin-grafana migration 009', async () => {
    const ext = await rows<{ extname: string }>(
      pg,
      `SELECT extname FROM pg_extension WHERE extname LIKE 'timescaledb%' ORDER BY 1`,
    )
    expect(ext.map((e) => e.extname)).toEqual([
      'timescaledb',
      'timescaledb_toolkit',
    ])
    const caggs = await rows<{ view_name: string }>(
      pg,
      `SELECT view_name FROM timescaledb_information.continuous_aggregates ORDER BY 1`,
    )
    expect(caggs.map((c) => c.view_name)).toEqual([
      'gps_cells_daily',
      'hourly_medians',
      'samples_hourly',
      'wear_hourly',
    ])
  })

  it('aggregates heart rate readings into hourly heartbeat aggregates', async () => {
    await refresh(pg)
    expect(
      await rows(
        pg,
        `SELECT bucket::text, uptime(wear)::text AS uptime, num_gaps(wear)::int AS gaps
         FROM wear_hourly ORDER BY bucket`,
      ),
    ).toEqual([
      { bucket: '2024-03-01 00:00:00+00', uptime: '00:30:00', gaps: 1 },
      { bucket: '2024-03-01 01:00:00+00', uptime: '00:50:00', gaps: 1 },
      { bucket: '2024-03-01 02:00:00+00', uptime: '00:54:00', gaps: 1 },
      { bucket: '2024-03-01 04:00:00+00', uptime: '00:28:00', gaps: 2 },
    ])
    // the stored values, as a pg_dump writes them
    const wear = await rows<{ wear: string }>(
      pg,
      `SELECT wear::text FROM wear_hourly ORDER BY bucket LIMIT 1`,
    )
    expect(wear[0].wear).toBe(
      '(version:1,start_time:762566400000000,end_time:762570000000000,last_seen:762568080000000,' +
        'interval_len:120000000,num_intervals:1,interval_starts:[762566400000000],' +
        'interval_ends:[762568200000000])',
    )
    expect(
      await rows(
        pg,
        `SELECT bucket::text, median FROM hourly_medians ORDER BY bucket`,
      ),
    ).toEqual(
      [
        '2024-03-01 00:00:00+00',
        '2024-03-01 01:00:00+00',
        '2024-03-01 02:00:00+00',
        '2024-03-01 04:00:00+00',
      ].map((bucket) => ({ bucket, median: 60 })),
    )
  })

  it('merges hours with rollup and returns worn and not worn periods', async () => {
    await refresh(pg)
    expect(await liveRanges(pg)).toEqual(wornRanges)
    expect(
      await rows(
        pg,
        `SELECT start::text, "end"::text
         FROM dead_ranges((SELECT rollup(wear) FROM wear_hourly)) ORDER BY start`,
      ),
    ).toEqual([
      { start: '2024-03-01 00:30:00+00', end: '2024-03-01 01:10:00+00' },
      { start: '2024-03-01 02:20:00+00', end: '2024-03-01 02:26:00+00' },
      { start: '2024-03-01 03:00:00+00', end: '2024-03-01 04:14:00+00' },
      { start: '2024-03-01 04:42:00+00', end: '2024-03-01 05:00:00+00' },
    ])
  })

  it('gives the same worn periods in real time, before any refresh', async () => {
    expect(await liveRanges(pg)).toEqual(wornRanges)
  })

  it('reports errors from Toolkit and keeps working', async () => {
    await expect(
      pg.query(
        `SELECT heartbeat_agg(time, '2024-03-01', '1 hour', '2 minutes') FROM samples`,
      ),
    ).rejects.toThrow(
      "all points passed to heartbeat agg must occur in the 'agg_duration' interval after 'agg_start'",
    )
    await expect(
      pg.query(`SELECT 'not a heartbeat'::heartbeatagg`),
    ).rejects.toThrow()
    expect(await rows(pg, `SELECT count(*)::int AS n FROM samples`)).toEqual([
      { n: 184 },
    ])
  })

  it('runs the rollups refresh policies with runDueJobs', async () => {
    const { runs } = await pg.timescaledb.runDueJobs()
    expect(runs.every((r) => r.success)).toBe(true)
    await pg.exec(
      `ALTER MATERIALIZED VIEW wear_hourly SET (timescaledb.materialized_only = true)`,
    )
    expect(await liveRanges(pg)).toEqual(wornRanges)
  })

  it('restores a pg_dump with stored heartbeat aggregates', async () => {
    await refresh(pg)
    const dump = await (await pgDump({ pg })).text()

    const restored = (await PGlite.create({ extensions })) as PG
    try {
      await restored.exec('CREATE EXTENSION IF NOT EXISTS timescaledb')
      await restored.query('SELECT timescaledb_pre_restore()')
      await restored.exec(dump)
      await restored.exec('RESET search_path')
      await restored.query('SELECT timescaledb_post_restore()')

      // only what was materialized, as restored from the dump
      await restored.exec(
        `ALTER MATERIALIZED VIEW wear_hourly SET (timescaledb.materialized_only = true)`,
      )
      expect(await liveRanges(restored)).toEqual(wornRanges)
    } finally {
      await restored.close()
    }
  })
})
