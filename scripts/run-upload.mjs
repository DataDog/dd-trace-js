import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

/* eslint-disable no-console */

/**
 * @typedef {object} UploadResult
 * @property {string} step
 * @property {string} seconds
 * @property {number} code
 * @property {string} output
 */

/**
 * Spawn a report-upload CLI once, buffering its output instead of streaming it live: several of
 * these run concurrently, so their combined stdout would interleave into unreadable noise.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<UploadResult>}
 */
function spawnUpload (command, args) {
  return new Promise(resolve => {
    const start = Date.now()
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', err => { output += err.message })
    child.on('close', code => {
      const seconds = ((Date.now() - start) / 1000).toFixed(1)
      resolve({ step: `${command} ${args[0]}`, seconds, code: code ?? 1, output })
    })
  })
}

/**
 * Run a report-upload CLI once. Sets `process.exitCode` on a non-zero exit so a failed upload
 * still fails the All Green job.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<UploadResult>}
 */
export async function runUpload (command, args) {
  const result = await spawnUpload(command, args)
  if (result.code !== 0) process.exitCode = 1
  return result
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {number} retries
 * @param {number} delayMs
 * @param {number} attempt
 * @returns {Promise<UploadResult>}
 */
async function attemptUpload (command, args, retries, delayMs, attempt) {
  const result = await spawnUpload(command, args)
  if (result.code === 0 || attempt > retries) return result
  console.log(`[retry ${attempt}/${retries}] ${command} ${args[0]} exited ${result.code}, retrying`)
  await sleep(delayMs)
  return attemptUpload(command, args, retries, delayMs, attempt + 1)
}

/**
 * Run a report-upload CLI, retrying on failure with a backoff delay. `codecovcli` calls pass
 * `--fail-on-error`, so a rejected request (e.g. hitting Codecov mid-outage) now surfaces as a
 * non-zero exit instead of being silently logged and ignored — retrying absorbs the transient
 * failures that flag exposes, without masking a persistent one, which still fails the job once
 * retries are exhausted.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {number} [retries]
 * @param {number} [delayMs]
 * @returns {Promise<UploadResult>}
 */
export async function runUploadWithRetry (command, args, retries = 2, delayMs = 2000) {
  const result = await attemptUpload(command, args, retries, delayMs, 1)
  if (result.code !== 0) process.exitCode = 1
  return result
}

/**
 * Log every upload run for a single workflow run as one line, instead of one line per upload CLI
 * call, and dump the buffered output of any that failed.
 *
 * @param {string} label
 * @param {UploadResult[]} results
 * @returns {void}
 */
export function logUploads (label, results) {
  if (results.length === 0) {
    console.log(`[${label}] nothing to upload`)
    return
  }
  const summary = results.map(r => `${r.step} ${r.seconds}s (exit ${r.code})`).join(', ')
  console.log(`[${label}] ${summary}`)
  for (const result of results) {
    if (result.code !== 0) console.log(result.output)
  }
}
