import { formatQuery, type PGliteInterface } from '@electric-sql/pglite'

export interface RunDueJobsOptions {
  /** Run at most this many jobs, the most overdue first. */
  maxJobs?: number
}

export interface JobRun {
  jobId: number
  success: boolean
  durationMs: number
  /** The error the job raised, if it failed. */
  error?: Error
}

export interface RunDueJobsResult {
  /** The jobs that ran, in order. */
  runs: JobRun[]
  /**
   * True if due jobs were left to run later because a transaction block was
   * open: jobs commit their own transactions, so they cannot run inside one.
   */
  deferred: boolean
  /** When the next job is due, or null if no job is scheduled. */
  nextStart: Date | null
}

// SQLSTATE active_sql_transaction
const ACTIVE_SQL_TRANSACTION = '25001'

/** What PGlite (but not every PGliteInterface) offers to guard a statement. */
interface TransactionGuard {
  _runExclusiveTransaction<T>(fn: () => Promise<T>): Promise<T>
  isInTransaction(): boolean
}

const hasTransactionGuard = (
  pg: PGliteInterface,
): pg is PGliteInterface & TransactionGuard =>
  typeof (pg as any)._runExclusiveTransaction === 'function' &&
  typeof (pg as any).isInTransaction === 'function'

const encoder = new TextEncoder()

/** A simple query protocol message. */
const queryMessage = (sql: string) => {
  const text = encoder.encode(sql)
  const message = new Uint8Array(1 + 4 + text.length + 1)
  message[0] = 'Q'.charCodeAt(0)
  new DataView(message.buffer).setInt32(1, 4 + text.length + 1)
  message.set(text, 5)
  return message
}

/**
 * Execute a statement unless a transaction block is open. An error raised by a
 * statement inside a transaction block would abort the user's transaction, so
 * the check and the statement happen while holding PGlite's transaction lock.
 * Returns false if the statement was not executed.
 */
async function execOutsideTransaction(
  pg: PGliteInterface,
  sql: string,
): Promise<boolean> {
  if (!hasTransactionGuard(pg)) {
    // e.g. the client side of a PGliteWorker; job_run_with_stats refuses to
    // run inside a transaction block itself
    try {
      await pg.exec(sql)
    } catch (error: any) {
      if (error?.code === ACTIVE_SQL_TRANSACTION) return false
      throw error
    }
    return true
  }
  return await pg._runExclusiveTransaction(async () => {
    if (pg.isInTransaction()) return false
    await pg.runExclusive(() => pg.execProtocol(queryMessage(sql)))
    return true
  })
}

/**
 * Run the TimescaleDB jobs that are due.
 *
 * Each job runs in its own CALL, outside any transaction block, so it can
 * commit as it goes. Statistics, next_start, retries and the job error log
 * are maintained by TimescaleDB (see _timescaledb_functions.job_schedule()).
 */
export async function runDueJobs(
  pg: PGliteInterface,
  { maxJobs = Infinity }: RunDueJobsOptions = {},
): Promise<RunDueJobsResult> {
  const due = await pg.query<{ job_id: number }>(
    'SELECT job_id FROM _timescaledb_functions.job_schedule() WHERE due',
  )

  const runs: JobRun[] = []
  let deferred = false
  for (const { job_id: jobId } of due.rows.slice(0, maxJobs)) {
    const start = performance.now()
    try {
      if (
        !(await execOutsideTransaction(
          pg,
          `CALL _timescaledb_functions.job_run_with_stats(${jobId})`,
        ))
      ) {
        deferred = true
        break
      }
      runs.push({ jobId, success: true, durationMs: performance.now() - start })
    } catch (error: any) {
      const durationMs = performance.now() - start
      const markFailed = await formatQuery(
        pg,
        'SELECT _timescaledb_functions.job_mark_failed($1, $2, $3, $4, $5)',
        [
          jobId,
          error?.code ?? null,
          error?.message ?? String(error),
          error?.detail ?? null,
          error?.hint ?? null,
        ],
      )
      // if a transaction block was opened in the meantime, the failure is not
      // recorded and job_schedule() later reports the run as a crash instead
      await execOutsideTransaction(pg, markFailed)
      runs.push({ jobId, success: false, durationMs, error })
    }
  }

  const next = await pg.query<{ next_start: Date | null }>(
    'SELECT min(next_start) AS next_start FROM _timescaledb_functions.job_schedule()',
  )
  return { runs, deferred, nextStart: next.rows[0].next_start }
}
