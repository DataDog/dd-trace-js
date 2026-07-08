import { spawn } from 'node:child_process'

/* eslint-disable no-console */

/**
 * Run a report-upload CLI, buffering its output instead of streaming it live: several of these run
 * concurrently, so their combined stdout would interleave into unreadable noise. Only a one-line
 * summary is logged on success; the buffered output is dumped on failure, and `process.exitCode` is
 * set so a failed upload still fails the All Green job.
 *
 * @param {string} label
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<void>}
 */
export function runUpload (label, command, args) {
  return new Promise(resolve => {
    const start = Date.now()
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('close', code => {
      const seconds = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`[${label}] ${command} ${args[0]}: ${seconds}s (exit ${code})`)
      if (code !== 0) {
        console.log(output)
        process.exitCode = 1
      }
      resolve()
    })
  })
}
