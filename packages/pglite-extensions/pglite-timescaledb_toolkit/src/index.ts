import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterface,
} from '@electric-sql/pglite'

const setup = async (_pg: PGliteInterface, emscriptenOpts: any) => {
  return {
    emscriptenOpts,
    bundlePath: new URL(
      '../release/timescaledb_toolkit.tar.gz',
      import.meta.url,
    ),
  } satisfies ExtensionSetupResult
}

export const timescaledb_toolkit = {
  name: 'timescaledb_toolkit',
  setup,
} satisfies Extension
