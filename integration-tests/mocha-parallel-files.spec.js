'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..')
const parallelScript = path.join(repoRoot, 'scripts', 'mocha-parallel-files.js')
const fixturesDir = path.join(__dirname, 'mocha-parallel-files-fixtures')

/**
 * @typedef {{
 *   stdout: string,
 *   stderr: string,
 *   code: number|null,
 *   signal: NodeJS.Signals|null
 * }} ChildResult
 *
 * @typedef {{
 *   killSignal?: NodeJS.Signals,
 *   killOnFirstStdout?: boolean,
 *   timeoutMs?: number
 * }} RunOpts
 */

/**
 * @param {string[]} args
 * @param {RunOpts} [opts]
 * @returns {Promise<ChildResult>}
 */
function runParallel (args, opts = {}) {
  return new Promise((resolve, reject) => {
    // Drop CI from the inherited env; otherwise mocha-parallel-files writes a
    // junit file under the repo root for every spawn here.
    const env = { ...process.env, CI: '' }
    const child = spawn(process.execPath, [parallelScript, ...args], { cwd: repoRoot, env })
    let stdout = ''
    let stderr = ''
    let killed = false
    const fireKill = () => {
      if (killed || !opts.killSignal) return
      killed = true
      child.kill(opts.killSignal)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      // The first stdout chunk proves the parent has finished its bootstrap,
      // registered SIGINT/SIGTERM handlers, and is forwarding output from a
      // running child. Sending the signal earlier races the handler setup,
      // which on slow CI lets the default signal terminate the parent before
      // it can pin its exit code.
      if (opts.killOnFirstStdout) fireKill()
    })
    child.stderr.on('data', (chunk) => { stderr += chunk })

    const timeoutMs = opts.timeoutMs ?? 20_000
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`mocha-parallel-files did not exit within ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref()

    child.once('error', reject)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code, signal })
    })
  })
}

describe('mocha-parallel-files script', function () {
  this.timeout(30_000)

  it('records child stats even when the child sends an unrelated IPC payload first', async () => {
    const fixture = path.join(fixturesDir, 'extra-ipc-message.js')
    const { stdout, code, signal } = await runParallel(['--', fixture])

    assert.strictEqual(code, 0)
    assert.strictEqual(signal, null)
    assert.match(stdout, /Total:\s+1\b/)
    assert.match(stdout, /Passed:\s+1\b/)
    assert.match(stdout, /Failed:\s+0\b/)
  })

  it('preserves the SIGINT exit code on user interrupt', async function () {
    if (process.platform === 'win32') {
      this.skip()
      return
    }
    const fixture = path.join(fixturesDir, 'long-running.js')
    const { code } = await runParallel(['--', fixture], { killSignal: 'SIGINT', killOnFirstStdout: true })
    assert.strictEqual(code, 130)
  })
})
