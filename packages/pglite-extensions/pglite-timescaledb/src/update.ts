import type { PGliteInterface } from '@electric-sql/pglite'

/**
 * Moves a database to the TimescaleDB version in this package, when it was
 * created with an older one.
 *
 * TimescaleDB loads the library of the version installed in the database
 * (timescaledb-<version>.so), and this package only contains the library of
 * its own version. On a server, `ALTER EXTENSION timescaledb UPDATE` runs as
 * the first statement of a new session, before anything loads the old
 * version. PGlite runs statements of its own while it starts, so the package
 * starts PostgreSQL with `timescaledb.disable_load = on` and this function,
 * which runs before the application gets the database, updates the extension
 * and turns loading back on.
 */
export async function updateExtension(pg: PGliteInterface) {
  const versions = await pg.query<{
    installed: string | null
    available: string
    updatable: boolean
  }>(`
    SELECT e.extversion AS installed, a.default_version AS available,
           EXISTS (SELECT 1 FROM pg_extension_update_paths('timescaledb') p
                   WHERE p.source = e.extversion AND p.target = a.default_version
                     AND p.path IS NOT NULL) AS updatable
    FROM pg_available_extensions a
    LEFT JOIN pg_extension e ON e.extname = a.name
    WHERE a.name = 'timescaledb'`)
  const { installed, available, updatable } = versions.rows[0]

  if (installed !== null && installed !== available && !updatable) {
    throw new Error(
      `The database uses TimescaleDB ${installed}, and this version of ` +
        `@electric-sql/pglite-timescaledb contains TimescaleDB ${available}, ` +
        `which cannot update it. TimescaleDB updates only from released ` +
        `versions to newer ones.`,
    )
  }

  // RESET would go back to the postgresql.conf value, which is on
  await pg.exec('SET timescaledb.disable_load = off')
  if (installed !== null && installed !== available) {
    // the first statement that loads TimescaleDB, so the old library is never loaded
    await pg.exec('ALTER EXTENSION timescaledb UPDATE')
  }
}
