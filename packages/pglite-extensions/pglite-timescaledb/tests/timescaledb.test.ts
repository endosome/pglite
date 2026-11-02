import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { timescaledb } from '../src/index.js'

describe(`timescaledb`, () => {
  let pg: PGlite
  let dataDirArchive: File | Blob

  beforeEach(async () => {
    if (!dataDirArchive) {
      pg = await PGlite.create({
        extensions: { timescaledb },
      })
      dataDirArchive = await pg.dumpDataDir('gzip')
    } else {
      pg = await PGlite.create({
        extensions: { timescaledb },
        loadDataDir: dataDirArchive,
      })
    }
    await pg.exec('CREATE EXTENSION IF NOT EXISTS timescaledb;')
  })
  afterEach(async () => {
    if (!pg.closed) {
      await pg.close()
    }
  })

  it('can load extension', async () => {
    const res = await pg.query<{ extname: string }>(`
        SELECT extname
        FROM pg_extension
        WHERE extname = 'timescaledb'
      `)

    expect(res.rows).toHaveLength(1)
    expect(res.rows[0].extname).toBe('timescaledb')
  })

  it('loads the library of the installed version, also after a reopen', async () => {
    const state = async (db: PGlite) =>
      (
        await db.query<{
          disable_load: string
          installed: string
          loaded: string
        }>(`
          SELECT current_setting('timescaledb.disable_load') AS disable_load,
                 (SELECT extversion FROM pg_extension WHERE extname = 'timescaledb') AS installed,
                 time_bucket('1 hour', now()) IS NOT NULL AS loaded`)
      ).rows[0]
    const fresh = await state(pg)
    expect(fresh).toMatchObject({ disable_load: 'off', loaded: true })

    const reopened = await PGlite.create({
      extensions: { timescaledb },
      loadDataDir: await pg.dumpDataDir('gzip'),
    })
    try {
      expect(await state(reopened)).toEqual(fresh)
    } finally {
      await reopened.close()
    }
  })

  it('creates a hypertable and buckets data', async () => {
    await pg.exec(`
      CREATE TABLE metrics (
        id SERIAL,
        ts TIMESTAMPTZ NOT NULL,
        value INTEGER NOT NULL,
        PRIMARY KEY (id, ts)
      );
      SELECT create_hypertable('metrics', 'ts');
    `)

    await pg.exec(`
      INSERT INTO metrics (ts, value) VALUES
        ('2024-01-01T00:00:00Z', 20),
        ('2024-01-01T06:00:00Z', 22),
        ('2024-01-02T00:00:00Z', 19),
        ('2024-01-02T12:00:00Z', 23);
    `)

    const hypertables = await pg.query<{ hypertable_name: string }>(`
      SELECT hypertable_name
      FROM timescaledb_information.hypertables
      WHERE hypertable_name = 'metrics'
    `)
    expect(hypertables.rows).toHaveLength(1)

    const buckets = await pg.query<{ bucket: string; avg_value: string }>(`
      SELECT
        time_bucket('1 day', ts) AS bucket,
        AVG(value) AS avg_value
      FROM metrics
      GROUP BY bucket
      ORDER BY bucket;
    `)

    expect(buckets.rows).toHaveLength(2)
    expect(new Date(buckets.rows[0].bucket).toISOString()).toBe(
      '2024-01-01T00:00:00.000Z',
    )
    expect(Number(buckets.rows[0].avg_value)).toBe(21)
    expect(new Date(buckets.rows[1].bucket).toISOString()).toBe(
      '2024-01-02T00:00:00.000Z',
    )
    expect(Number(buckets.rows[1].avg_value)).toBe(21)
  })

  it('IOT sample', async () => {
    // https://docs.timescale.com/getting-started/latest/
    await pg.exec(`
      CREATE TABLE sensors(
        id SERIAL PRIMARY KEY,
        type VARCHAR(50),
        location VARCHAR(50)
      );
    `)
    await pg.exec(`
      CREATE TABLE sensor_data (
        time TIMESTAMPTZ NOT NULL,
        sensor_id INTEGER,
        temperature DOUBLE PRECISION,
        cpu DOUBLE PRECISION,
        FOREIGN KEY (sensor_id) REFERENCES sensors (id)
      ) WITH (
        tsdb.hypertable
      );
    `)

    await pg.exec(`
      INSERT INTO sensors (type, location) VALUES
        ('a','floor'),
        ('a', 'ceiling'),
        ('b','floor'),
        ('b', 'ceiling');
    `)

    await pg.exec(`
      INSERT INTO sensor_data (time, sensor_id, cpu, temperature)
      SELECT
        time,
        sensor_id,
        random() AS cpu,
        random()*100 AS temperature
      FROM generate_series(
        '2024-01-01T00:00:00Z'::timestamptz,
        '2024-01-02T00:00:00Z'::timestamptz,
        interval '5 minute'
      ) AS g1(time), generate_series(1,4,1) AS g2(sensor_id);
    `)

    const res = await pg.query<{
      location: string
      period: Date
      avg_temp: number
      last_temp: number
      avg_cpu: number
    }>(`
      SELECT
        sensors.location,
        time_bucket('30 minutes', time) AS period,
        AVG(temperature) AS avg_temp,
        last(temperature, time) AS last_temp,
        AVG(cpu) AS avg_cpu
      FROM sensor_data JOIN sensors on sensor_data.sensor_id = sensors.id
      GROUP BY period, sensors.location
      ORDER BY period, sensors.location;
    `)

    // 24h in 30 minute buckets plus the bucket holding the final 00:00 sample, for 2 locations
    expect(res.rows).toHaveLength(49 * 2)
    for (const row of res.rows) {
      expect(row.avg_temp).toBeGreaterThanOrEqual(0)
      expect(row.avg_temp).toBeLessThan(100)
      expect(row.last_temp).toBeGreaterThanOrEqual(0)
      expect(row.last_temp).toBeLessThan(100)
    }
  })

  it('clone keeps the extension loaded', async () => {
    await pg.exec(`
      CREATE TABLE readings (ts TIMESTAMPTZ NOT NULL, value INTEGER);
      SELECT create_hypertable('readings', 'ts');
      INSERT INTO readings VALUES ('2024-01-01T00:00:00Z', 1), ('2024-01-01T01:00:00Z', 3);
    `)

    const cloned = await pg.clone()
    try {
      const res = await cloned.query<{ avg: string }>(`
        SELECT AVG(value) AS avg FROM readings
        GROUP BY time_bucket('1 day', ts);
      `)
      expect(res.rows).toHaveLength(1)
      expect(Number(res.rows[0].avg)).toBe(2)
    } finally {
      await cloned.close()
    }
  })
})
