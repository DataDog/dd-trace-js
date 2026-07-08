import { spawn } from 'node:child_process'

/* eslint-disable no-console */

/**
 * @typedef {object} UploadResult
 * @property {string} step
 * @property {string} seconds
 * @property {number} code
 * @property {string} output
 */

/**
 * Run a report-upload CLI, buffering its output instead of streaming it live: several of these run
 * concurrently, so their combined stdout would interleave into unreadable noise. Sets
 * `process.exitCode` on a non-zero exit so a failed upload still fails the All Green job.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<UploadResult>}
 */
export function runUpload (command, args) {
  return new Promise(resolve => {
    const start = Date.now()
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('close', code => {
      const seconds = ((Date.now() - start) / 1000).toFixed(1)
      if (code !== 0) process.exitCode = 1
      resolve({ step: `${command} ${args[0]}`, seconds, code, output })
    })
  })
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
