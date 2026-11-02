# @electric-sql/pglite-timescaledb

[TimescaleDB](https://github.com/timescale/timescaledb) extension for [PGlite](https://pglite.dev).

PGlite has no background workers, so TimescaleDB's job scheduler does not run. Jobs (compression, retention and
continuous aggregate refresh policies, and user-defined actions) run when the application calls `runDueJobs()`, see
[Background jobs](#background-jobs).

## Installation

```bash
npm install @electric-sql/pglite-timescaledb
```

## Usage

```typescript
import { PGlite } from '@electric-sql/pglite'
import { timescaledb } from '@electric-sql/pglite-timescaledb'

const pg = new PGlite({
  extensions: {
    timescaledb,
  },
})

await pg.exec('CREATE EXTENSION IF NOT EXISTS timescaledb;')
```

## Background jobs

`pg.timescaledb.runDueJobs()` runs the jobs that are due, one after the other, with the same bookkeeping as
TimescaleDB's scheduler: `timescaledb_information.job_stats`, `next_start` (including fixed schedules), retries after
failures, and `timescaledb_information.job_errors`.

```typescript
await pg.exec(`SELECT add_compression_policy('metrics', INTERVAL '7 days')`)

const { runs, nextStart } = await pg.timescaledb.runDueJobs({ maxJobs: 1 })
```

- `runs` lists each job that ran with its `jobId`, `success`, `durationMs` and, if it failed, the `error`.
- `nextStart` is when the next job is due (or `null` if no job is scheduled), to schedule the next call.
- `maxJobs` limits how many jobs run in one call.
- Jobs commit their own transactions, so they do not run while a transaction block is open; they stay due and `deferred`
  is `true`.

Each job blocks all other queries while it runs, as PGlite has a single connection, and a job's `max_runtime` is not
enforced. A run that never finished (for example because the page was closed) is reported as a crash the next time, and
the job is retried after a backoff.

For example, the first refresh of a continuous aggregate over a year of 1-minute samples takes about 10 s, and the
refreshes after that, which only recompute the buckets that changed, take milliseconds.

## TimescaleDB versions

This package contains one TimescaleDB release. When it opens a database that was created with an older TimescaleDB
release, it updates the extension (`ALTER EXTENSION timescaledb UPDATE`) before `PGlite.create()` returns. To make this
possible, PostgreSQL starts with `timescaledb.disable_load = on` and the package turns loading on again once the versions
match.

A database with a newer TimescaleDB, or with a development version, cannot be opened: TimescaleDB updates only from
released versions to newer ones, never back.

## Restoring a pg_dump

The dump has to come from the same TimescaleDB version: `timescaledb_post_restore()` rejects a catalog of another
version. Update the source database first, or restore into a server with the old version and update it there.

Wrap the restore in `timescaledb_pre_restore()` / `timescaledb_post_restore()` as usual. A `pg_dump` script sets
`search_path` to `''`, and since PGlite has a single session that setting stays in effect after the restore, so reset it
before calling `timescaledb_post_restore()`:

```typescript
import { pgDump } from '@electric-sql/pglite-tools'

const dump = await (await pgDump({ pg: source })).text()

await target.exec('CREATE EXTENSION IF NOT EXISTS timescaledb')
await target.query('SELECT timescaledb_pre_restore()')
await target.exec(dump)
await target.exec('RESET search_path')
await target.query('SELECT timescaledb_post_restore()')
```

## License

Apache-2.0
