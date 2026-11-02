import { PGlite } from '@electric-sql/pglite'
import PgDumpModFactory, { PgDumpMod } from './pgDumpModFactory'

const dumpFilePath = '/tmp/out.sql'

/**
 * Creates a new Uint8Array based on two different ArrayBuffers
 *
 * @private
 * @param {ArrayBuffers} buffer1 The first buffer.
 * @param {ArrayBuffers} buffer2 The second buffer.
 * @return {ArrayBuffers} The new ArrayBuffer created out of the two.
 */
function concat(buffer1: ArrayBuffer, buffer2: ArrayBuffer) {
  const tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength)
  tmp.set(new Uint8Array(buffer1), 0)
  tmp.set(new Uint8Array(buffer2), buffer1.byteLength)
  return tmp
}

interface ExecResult {
  exitCode: number
  fileContents: string
  stderr: string
  stdout: string
}

export const PG_ROOT = '/pglite'

/**
 * Inner function to execute pg_dump
 */
async function execPgDump({
  pg,
  args,
}: {
  pg: PGlite
  args: string[]
}): Promise<ExecResult> {
  let pgdump_write, pgdump_read
  let exitCode = 0
  let stderrOutput: string = ''
  let stdoutOutput: string = ''
  const emscriptenOpts: Partial<PgDumpMod> = {
    noExitRuntime: false,
    print: (text) => {
      stdoutOutput += text
    },
    printErr: (text) => {
      stderrOutput += text
    },
    onExit: (status: number) => {
      exitCode = status
    },
    preRun: [
      (mod: PgDumpMod) => {
        mod.ENV.HOME = '/home/postgres'
        mod.ENV.USER = 'postgres'
        mod.ENV.LOGNAME = 'postgres'
      },
      (mod: PgDumpMod) => {
        mod.onRuntimeInitialized = () => {
          let bufferedBytes: Uint8Array = new Uint8Array()

          pgdump_write = mod.addFunction((ptr: number, length: number) => {
            let bytes
            try {
              bytes = mod.HEAPU8.subarray(ptr, ptr + length)
            } catch (e: any) {
              console.error('error', e)
              throw e
            }
            pg.execProtocolRawStream(bytes, {
              onRawData: (bytes) => {
                bufferedBytes = concat(bufferedBytes, bytes)
              },
            })

            return length
          }, 'ipi')

          pgdump_read = mod.addFunction((ptr: number, max_length: number) => {
            let length = bufferedBytes.length
            if (length > max_length) {
              length = max_length
            }
            try {
              mod.HEAPU8.set(bufferedBytes.subarray(0, length), ptr)
            } catch (e) {
              console.error(e)
            }
            bufferedBytes = bufferedBytes.subarray(length, bufferedBytes.length)
            return length
          }, 'ipi')

          mod._pgl_set_rw_cbs(pgdump_read, pgdump_write)
        }
      },
      (mod: PgDumpMod) => {
        mod.FS.mkdirTree(PG_ROOT)
        mod.FS.mount(
          mod.PROXYFS,
          {
            root: PG_ROOT,
            fs: pg.Module.FS,
          },
          PG_ROOT,
        )
        mod.FS.mkdirTree('/home')
        mod.FS.mount(
          mod.PROXYFS,
          {
            root: '/home',
            fs: pg.Module.FS,
          },
          '/home',
        )
        // default $HOME in emscripten is /home/postgres
        mod.FS.chmod('/home/postgres/.pgpass', 0o0600) // https://www.postgresql.org/docs/current/libpq-pgpass.html
      },
    ],
  }

  const mod = await PgDumpModFactory(emscriptenOpts)
  mod.callMain(args)
  let fileContents = ''
  if (!exitCode) {
    fileContents = mod.FS.readFile(dumpFilePath, { encoding: 'utf8' })
    mod.FS.unlink(dumpFilePath)
  }

  return {
    exitCode,
    fileContents,
    stderr: stderrOutput,
    stdout: stdoutOutput,
  }
}

interface PgDumpOptions {
  pg: PGlite
  args?: string[]
  database?: string
  fileName?: string
  verbose?: boolean
}

/**
 * Execute pg_dump
 * @param pg - The PGlite instance
 * @param args - The arguments to pass to pg_dump
 * @param fileName - The name of the file to write the dump to (dump.sql by default)
 * @returns The file containing the dump
 */
export async function pgDump({
  pg,
  args,
  fileName = 'dump.sql',
}: PgDumpOptions) {
  // pg_dump runs in PGlite's single session, the one the application uses, and
  // sets session parameters for itself (search_path, restrict_nonsystem_relation_kind,
  // row_security, timeouts, ...). They are restored afterwards. The transaction_*
  // parameters describe the current transaction, not the session.
  const sessionSettings = async () =>
    (
      await pg.query<{ name: string; setting: string }>(
        `SELECT name, setting FROM pg_settings
         WHERE context IN ('user', 'superuser') AND name NOT LIKE 'transaction\\_%'`,
      )
    ).rows
  const settingsBefore = new Map(
    (await sessionSettings()).map(({ name, setting }) => [name, setting]),
  )

  const baseArgs = [
    '-U',
    'postgres',
    '--inserts',
    '-j',
    '1',
    '-f',
    dumpFilePath,
  ]

  const execResult = await execPgDump({
    pg,
    args: [...(args ?? []), ...baseArgs],
  })

  await pg.exec(`DEALLOCATE ALL`)
  for (const { name, setting } of await sessionSettings()) {
    const before = settingsBefore.get(name)
    if (before !== undefined && before !== setting) {
      await pg.query('SELECT set_config($1, $2, false)', [name, before])
    }
  }

  if (execResult.exitCode !== 0) {
    throw new Error(
      `pg_dump failed with exit code ${execResult.exitCode}. \nError message: ${execResult.stderr}`,
    )
  }

  // remove \\restrict and \\unrestrict commands https://www.postgresql.org/docs/17/app-psql.html#APP-PSQL-META-COMMAND-RESTRICT
  const contentsPruned = execResult.fileContents.replace(
    /^(?:\\(?:un)?restrict\b.*\r?\n?)/gim,
    '',
  )

  const file = new File([contentsPruned], fileName, {
    type: 'text/plain',
  })

  return file
}
