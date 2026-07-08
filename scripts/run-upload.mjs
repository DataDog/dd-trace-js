import { spawn } from 'node:child_process'

/* eslint-disable no-console */

/**
 * Run a report-upload CLI and stream its output straight to the job log, since several of these
 * run concurrently and their combined stdout is more useful live than buffered per-command. Sets
 * `process.exitCode` on a non-zero exit so a failed upload still fails the All Green job.
 *
 * @param {string} label
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<void>}
 */
export function runUpload (label, command, args) {
  return new Promise(resolve => {
    const start = Date.now()
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('close', code => {
      const seconds = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`[${label}] ${command} ${args[0]}: ${seconds}s (exit ${code})`)
      if (code !== 0) process.exitCode = 1
      resolve()
    })
  })
}
