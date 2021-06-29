'use strict'

const semver = require('semver')
const { EventEmitter } = require('events')
const { Config } = require('./config')
const { SourceMapper } = require('./mapper')

class Profiler extends EventEmitter {
  constructor () {
    super()
    this._enabled = false
    this._logger = undefined
    this._config = undefined
    this._timer = undefined
  }

  start (options) {
    if (this._enabled) return

    const config = this._config = new Config(options)

    if (!config.enabled) return

    this._logger = config.logger

    if (!semver.satisfies(process.version, '>=10.12')) {
      this._logger.error('Profiling could not be started because it requires Node >=10.12')
      return this
    }

    this._enabled = true

    try {
      const mapper = config.sourceMap ? new SourceMapper() : null

      for (const profiler of config.profilers) {
        // TODO: move this out of Profiler when restoring sourcemap support
        profiler.start({
          logger: this._logger,
          mapper
        })
      }
    } catch (e) {
      this._logger.error(e)
      this.stop()
    }

    this._capture(config.flushInterval)

    return this
  }

  stop () {
    if (!this._enabled) return

    this._enabled = false

    for (const profiler of this._config.profilers) {
      profiler.stop()
    }

    clearTimeout(this._timer)
    this._timer = undefined

    return this
  }

  _capture (timeout) {
    if (!this._enabled) return
    const start = new Date()

    if (!this._timer || timeout !== this._config.flushInterval) {
      this._timer = setTimeout(() => this._collect(start), timeout)
      this._timer.unref()
    } else {
      this._timer.refresh()
    }
  }

  async _collect (start) {
    const end = new Date()
    const profiles = {}

    try {
      for (const profiler of this._config.profilers) {
        const profile = await profiler.profile()
        if (!profile) continue

        profiles[profiler.type] = profile
      }

      this._capture(this._config.flushInterval)
      await this._submit(profiles, start, end)
    } catch (err) {
      this._logger.error(err)
      this.stop()
    }
  }

  _submit (profiles, start, end) {
    const { tags } = this._config
    const tasks = []

    for (const exporter of this._config.exporters) {
      const task = exporter.export({ profiles, start, end, tags })
        .catch(err => this._logger.error(err))

      tasks.push(task)
    }

    return Promise.all(tasks)
  }
}

module.exports = { Profiler }
