'use strict'

const { EventEmitter } = require('events')
const { Config } = require('./config')

function maybeSourceMap (sourceMap) {
  if (!sourceMap) return
  const { SourceMapper } = require('@datadog/pprof')
  return SourceMapper.create([
    process.cwd()
  ])
}

class Profiler extends EventEmitter {
  constructor () {
    super()
    this._enabled = false
    this._logger = undefined
    this._config = undefined
    this._timer = undefined
    this._lastStart = undefined
    this._timeoutInterval = undefined
  }

  start (options) {
    this._start(options).catch(() => {})
    return this
  }

  async _start (options) {
    if (this._enabled) return

    const config = this._config = new Config(options)
    if (!config.enabled) return

    this._logger = config.logger
    this._enabled = true
    this._setInterval()

    // Log errors if the source map finder fails, but don't prevent the rest
    // of the profiler from running without source maps.
    let mapper
    try {
      mapper = await maybeSourceMap(config.sourceMap)
    } catch (err) {
      this._logger.error(err)
    }

    try {
      for (const profiler of config.profilers) {
        // TODO: move this out of Profiler when restoring sourcemap support
        profiler.start({ mapper })
        this._logger.debug(`Started ${profiler.type} profiler`)
      }

      this._capture(this._timeoutInterval)
    } catch (e) {
      this._logger.error(e)
      this.stop()
    }
  }

  _setInterval () {
    this._timeoutInterval = this._config.flushInterval
  }

  stop () {
    if (!this._enabled) return

    this._enabled = false

    for (const profiler of this._config.profilers) {
      profiler.stop()
      this._logger.debug(`Stopped ${profiler.type} profiler`)
    }

    clearTimeout(this._timer)
    this._timer = undefined

    return this
  }

  _capture (timeout) {
    if (!this._enabled) return
    this._lastStart = new Date()
    if (!this._timer || timeout !== this._timeoutInterval) {
      this._timer = setTimeout(() => this._collect(), timeout)
      this._timer.unref()
    } else {
      this._timer.refresh()
    }
  }

  async _collect () {
    const start = this._lastStart
    const end = new Date()
    const profiles = {}

    try {
      for (const profiler of this._config.profilers) {
        const profile = profiler.profile()
        if (!profile) continue

        profiles[profiler.type] = await profiler.encode(profile)
        this._logger.debug(() => {
          const profileJson = JSON.stringify(profile, (key, value) => {
            return typeof value === 'bigint' ? value.toString() : value
          })
          return `Collected ${profiler.type} profile: ` + profileJson
        })
      }

      this._capture(this._timeoutInterval)
      await this._submit(profiles, start, end)
      this._logger.debug('Submitted profiles')
    } catch (err) {
      this._logger.error(err)
      this.stop()
    }
  }

  _submit (profiles, start, end) {
    if (!Object.keys(profiles).length) {
      return Promise.reject(new Error('No profiles to submit'))
    }
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

class ServerlessProfiler extends Profiler {
  constructor () {
    super()
    this._profiledIntervals = 0
    this._interval = 1
    this._flushAfterIntervals = undefined
  }

  _setInterval () {
    this._timeoutInterval = this._interval * 1000
    this._flushAfterIntervals = this._config.flushInterval / 1000
  }

  async _collect () {
    if (this._profiledIntervals >= this._flushAfterIntervals) {
      this._profiledIntervals = 0
      await super._collect()
    } else {
      this._profiledIntervals += 1
      this._capture(this._timeoutInterval)
      // Don't submit profile until 65 (flushAfterIntervals) intervals have elapsed
    }
  }
}

module.exports = { Profiler, ServerlessProfiler }
