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

    try {
      const mapper = await maybeSourceMap(config.sourceMap)

      for (const profiler of config.profilers) {
        // TODO: move this out of Profiler when restoring sourcemap support
        profiler.start({ mapper })
        this._logger.debug(`Started ${profiler.type} profiler`)
      }

      this._capture(config.flushInterval)
    } catch (e) {
      this._logger.error(e)
      this.stop()
    }
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

    if (!this._timer || timeout !== this._config.flushInterval) {
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
        this._logger.debug(`Collected ${profiler.type} profile: ` + JSON.stringify(profile))
      }

      this._capture(this._config.flushInterval)
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

module.exports = { Profiler }
