'use strict'

const childProcess = require('child_process')
const readline = require('readline')

const VARIANT_TIMEOUT_MS = Number(process.env.VARIANT_TIMEOUT_SECONDS ?? 75) * 1000
const FORCE_KILL_DELAY_MS = 5_000

if (!Number.isFinite(VARIANT_TIMEOUT_MS) || VARIANT_TIMEOUT_MS <= 0) {
  throw new Error('VARIANT_TIMEOUT_SECONDS must be a positive number')
}

function exec (...args) {
  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    const { timeoutMs, ...options } = args.at(-1)
    const detached = timeoutMs !== undefined && process.platform !== 'win32'
    const proc = childProcess.spawn(...args.slice(0, -1), { ...options, detached })
    let forceKillTimer
    let timedOut = false
    const timeout = timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
        timedOut = true
        kill(proc, detached, 'SIGTERM')
        forceKillTimer = setTimeout(() => kill(proc, detached, 'SIGKILL'), FORCE_KILL_DELAY_MS)
      }, timeoutMs)

    streamAddVersion(proc.stdout)
    proc.on('error', error => {
      clearTimeout(timeout)
      clearTimeout(forceKillTimer)
      reject(error)
    })
    proc.on('exit', (code) => {
      clearTimeout(timeout)
      clearTimeout(forceKillTimer)
      if (timedOut) {
        const error = new Error(`Benchmark exceeded the ${timeoutMs / 1000}-second variant limit`)
        error.code = 'ETIMEDOUT'
        reject(error)
        return
      }
      if (code === 0) {
        resolve()
      } else {
        reject(new Error('Process exited with non-zero code.'))
      }
    })
  }))
}

/**
 * @param {import('child_process').ChildProcess} proc
 * @param {boolean} detached
 * @param {NodeJS.Signals} signal
 */
function kill (proc, detached, signal) {
  if (proc.pid === undefined) return
  try {
    if (detached) process.kill(-proc.pid, signal)
    else proc.kill(signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

function streamAddVersion (input) {
  if (!input) return
  input.rl = readline.createInterface({ input })
  input.rl.on('line', function (line) {
    try {
      const json = JSON.parse(line.toString())
      json.nodeVersion = process.versions.node
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(json))
    } catch {
      // eslint-disable-next-line no-console
      console.log(line)
    }
  })
}

module.exports = {
  VARIANT_TIMEOUT_MS,
  exec,
  stdio: ['inherit', 'pipe', 'inherit'],
  streamAddVersion,
}
