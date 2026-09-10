'use strict'

const { fork } = require('node:child_process')
const { EventEmitter, once } = require('node:events')
const path = require('node:path')

/**
 * @typedef {EventEmitter & {
 *   error?: Error,
 *   exitCode: number|null,
 *   kill: () => void,
 *   output: string,
 *   signalCode: string|null
 * }} WdioRun
 */

class PersistentWdioRunner {
  #child
  #cwd
  #environment
  #nextRunId = 0
  #pendingRuns = new Map()
  #processOutput = ''
  #starting

  /**
   * @param {string} cwd
   * @param {Record<string, string|undefined>} environment
   */
  constructor (cwd, environment) {
    this.#cwd = cwd
    this.#environment = environment
  }

  /**
   * @param {string} cwd
   * @param {Record<string, string>} environment
   * @returns {Promise<WdioRun>}
   */
  async run (cwd, environment) {
    await this.#start()

    const execution = /** @type {WdioRun} */ (new EventEmitter())
    const id = this.#nextRunId++
    execution.exitCode = null
    execution.signalCode = null
    execution.output = ''
    execution.kill = () => {
      if (execution.exitCode === null && execution.signalCode === null) {
        this.#child?.kill()
      }
    }
    this.#pendingRuns.set(id, execution)
    this.#child.send({ cwd, environment, id, type: 'run' })
    return execution
  }

  /**
   * @returns {Promise<void>}
   */
  async stop () {
    const child = this.#child
    if (!child) return

    const childClosed = once(child, 'close')
    child.send({ type: 'shutdown' })
    await childClosed
  }

  /**
   * @returns {Promise<void>}
   */
  #start () {
    if (this.#starting) return this.#starting

    this.#starting = new Promise((resolve, reject) => {
      let isReady = false
      this.#processOutput = ''
      const child = this.#child = fork(path.join(this.#cwd, 'persistent-wdio-runner.js'), [], {
        cwd: this.#cwd,
        env: this.#environment,
        silent: true,
      })

      child.stdout.on('data', chunk => {
        this.#processOutput += chunk.toString()
      })
      child.stderr.on('data', chunk => {
        this.#processOutput += chunk.toString()
      })
      child.on('message', message => {
        if (message.type === 'ready') {
          isReady = true
          resolve()
          return
        }
        if (message.type !== 'result') return

        const execution = this.#pendingRuns.get(message.id)
        if (!execution) return
        this.#pendingRuns.delete(message.id)
        execution.output = message.output
        execution.exitCode = message.exitCode ?? 1
        if (message.error) {
          execution.error = Object.assign(new Error(message.error.message), { stack: message.error.stack })
        }
        execution.emit('exit', execution.exitCode, null)
        execution.emit('close', execution.exitCode, null)
      })
      child.once('error', error => {
        if (!isReady) reject(error)
      })
      child.once('close', (code, signal) => {
        this.#child = undefined
        this.#starting = undefined
        const error = new Error(
          `Persistent WebdriverIO runner exited with code ${code} and signal ${signal}.\n${this.#processOutput}`
        )
        if (!isReady) reject(error)
        for (const execution of this.#pendingRuns.values()) {
          execution.error = error
          execution.exitCode = code
          execution.signalCode = signal
          execution.emit('exit', code, signal)
          execution.emit('close', code, signal)
        }
        this.#pendingRuns.clear()
      })
    })

    return this.#starting
  }
}

module.exports = PersistentWdioRunner
