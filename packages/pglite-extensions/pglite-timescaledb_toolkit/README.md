# @electric-sql/pglite-timescaledb-toolkit

[TimescaleDB Toolkit](https://github.com/timescale/timescaledb-toolkit) extension for [PGlite](https://pglite.dev):
hyperfunctions such as `heartbeat_agg`, `rollup` and `live_ranges`, and other analytical functions.

Toolkit's continuous aggregate examples need TimescaleDB as well, from `@electric-sql/pglite-timescaledb`.

## Installation

```bash
npm install @electric-sql/pglite-timescaledb-toolkit
```

## Usage

```typescript
import { PGlite } from '@electric-sql/pglite'
import { timescaledb } from '@electric-sql/pglite-timescaledb'
import { timescaledb_toolkit } from '@electric-sql/pglite-timescaledb-toolkit'

const pg = new PGlite({
  extensions: {
    timescaledb,
    timescaledb_toolkit,
  },
})

await pg.exec('CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;')

const worn = await pg.query(`
  SELECT * FROM live_ranges((
    SELECT heartbeat_agg(time, '2024-03-01', '1 day', '2 minutes') FROM heart_rate
  ))`)
```

## Build

The extension is written in Rust (pgrx). It is built from
[endosome/timescaledb-toolkit](https://github.com/endosome/timescaledb-toolkit), which adds the build for PGlite
(`pglite/`) and fixes for 32-bit WebAssembly, where 8-byte types such as `timestamptz` are passed by reference.

## License

Apache-2.0
