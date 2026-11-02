import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterface,
} from '@electric-sql/pglite'
import {
  runDueJobs,
  type RunDueJobsOptions,
  type RunDueJobsResult,
} from './jobs.js'
import { updateExtension } from './update.js'

export type { JobRun, RunDueJobsOptions, RunDueJobsResult } from './jobs.js'

export interface TimescaledbNamespace {
  runDueJobs: (options?: RunDueJobsOptions) => Promise<RunDueJobsResult>
}

export type PGliteWithTimescaledb = PGliteInterface & {
  timescaledb: TimescaledbNamespace
}

const setup = async (
  pg: PGliteInterface,
  emscriptenOpts: any,
  clientOnly?: boolean,
) => {
  const namespaceObj: TimescaledbNamespace = {
    /**
     * Run the TimescaleDB jobs (policies and user-defined actions) that are
     * due, with the same bookkeeping as TimescaleDB's background job
     * scheduler, which is not available in PGlite.
     */
    runDueJobs: (options?: RunDueJobsOptions) => runDueJobs(pg, options),
  }
  if (clientOnly) {
    // the client side of a PGliteWorker: the worker opens the database
    return { emscriptenOpts, namespaceObj } satisfies ExtensionSetupResult
  }
  return {
    emscriptenOpts,
    namespaceObj,
    bundlePath: new URL('../release/timescaledb.tar.gz', import.meta.url),
    sharedPreloadLibraries: ['timescaledb'],
    // Nothing loads the TimescaleDB library until init() has checked the
    // database's TimescaleDB version, see updateExtension()
    postgresqlConf: ['timescaledb.disable_load = on'],
    init: () => updateExtension(pg),
  } satisfies ExtensionSetupResult
}

export const timescaledb = {
  name: 'timescaledb',
  setup,
} satisfies Extension
