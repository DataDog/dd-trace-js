'use strict'

const { EventEmitter } = require('events')
const { Config } = require('./config')
const { SourceMapper } = require('./mapper')
const { eachSeries } = require('./util')

class Profiler extends EventEmitter {
  start (options) {
    if (this._enabled) return

    const config = this._config = new Config(options)

    if (!config.enabled) return

    this._logger = config.logger

    this._enabled = true

    try {
      const mapper = config.sourceMap ? new SourceMapper() : null

      for (const profiler of config.profilers) {
        profiler.start({ mapper }) // TODO: move this outside of profilers
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

    return this
  }

  _capture (timeout) {
    const start = new Date()

    this._timer = setTimeout(() => this._collect(start), timeout)
    this._timer.unref()
  }

  _collect (start) {
    const end = new Date()
    const profiles = {}

    eachSeries(this._config.profilers, (profiler, callback) => {
      profiler.profile((err, profile) => {
        if (err) return callback(err)

        profiles[profiler.type] = profile

        callback(err, profile)
      })
    }, err => {
      if (err) {
        this._logger.error(err)
        this.stop()
      } else {
        this._capture(this._config.flushInterval)
        this._submit(profiles, start, end)
      }
    })
  }

  _submit (profiles, start, end) {
    const { tags } = this._config

    for (const exporter of this._config.exporters) {
      exporter.export({ profiles, start, end, tags }, err => {
        if (err) {
          this._logger.error(err)
        }
      })
    }
  }
}

module.exports = { Profiler }
