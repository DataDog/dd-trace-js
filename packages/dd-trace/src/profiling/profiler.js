'use strict'

const semver = require('semver')
const { EventEmitter } = require('events')
const { Config } = require('./config')
const { CompositeLogger } = require('./loggers/composite')
const { SourceMapper } = require('./mapper')

class Profiler extends EventEmitter {
  start (options) {
    if (this._enabled) return

    this._config = new Config(options)

    if (!this._config.enabled) return

    this._logger = new CompositeLogger(this._config)

    if (!semver.satisfies(process.version, '>=10.12')) {
      this._logger.error('Profiling could not be started because it requires Node >=10.12')
      return this
    }

    this._enabled = true

    try {
      const mapper = new SourceMapper()

      for (const profiler of this._config.profilers) {
        profiler.start({ mapper }) // TODO: move this outside of profilers
      }
    } catch (e) {
      this._logger.error(e)
      this.stop()
    }

    this._capture(this._config.flushInterval)

    return this
  }

  stop () {
    if (!this._enabled) return

    this._enabled = false

    for (const profiler of this._config.profilers) {
      profiler.stop()
    }

    clearTimeout(this._timer)

    return this
  }

  _capture (timeout) {
    const start = new Date()

    this._timer = setTimeout(() => this._collect(start), timeout)
    this._timer.unref()
  }

  async _collect (start) {
    try {
      const end = new Date()
      const profiles = {}

      for (const profiler of this._config.profilers) {
        profiles[profiler.type] = await profiler.profile()
      }

      this._capture(this._config.flushInterval)
      this._submit(profiles, start, end)
    } catch (e) {
      this._logger.error(e)
      this.stop()
    }
  }

  _submit (profiles, start, end) {
    const { tags } = this._config

    this._config.exporters
      .map(exporter => exporter.export({ profiles, start, end, tags }))
      .map(promise => {
        promise.catch((e) => this._logger.error(e))
      })
  }
}

module.exports = { Profiler }
