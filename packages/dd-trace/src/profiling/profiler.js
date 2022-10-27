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

    // FIXME: where to put these for the serverless capture? How to set up serverless capture?
    this._profiledIntervals = 0
    // FIXME: how to represent constants
    this._forcedInterval = 1
    this._flushAfterIntervals = 65
    this._lambdaFunctionName = process.env.AWS_LAMBDA_FUNCTION_NAME
    // TODO: remove
    this._numProfiles = 0
  }

  start (options) {
    console.log('[Amy:start] profile started, flushAfterIntervals:', this._flushAfterIntervals)
    this._start(options).catch(() => {})
    console.log('[Amy:start] after setting _start')
    return this
  }

  async _start (options) {
    console.log('[Amy:_start] beginning of method w/ lambda name:', this._lambdaFunctionName)
    if (this._enabled) return

    const config = this._config = new Config(options)
    if (!config.enabled) return

    this._logger = config.logger
    this._enabled = true

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
        console.log('[Amy:_start] starting profile:', profiler)
        // TODO: move this out of Profiler when restoring sourcemap support
        profiler.start({ mapper })
        this._logger.debug(`Started ${profiler.type} profiler`)
      }

      console.log('[Amy:_start] before this._capture call, config.flushInterval:', config.flushInterval)

      this._capture(config.flushInterval)
      console.log('[Amy:_start] after this._capture call')
    } catch (e) {
      console.log('[Amy:_start] errored', e)
      this._logger.error(e)
      this.stop()
    }
  }

  stop () {
    console.log('[Amy:stop] profile stopped')
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
    console.log('[Amy:_capture] beginning of method w timeout:', timeout)
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
    console.log('[Amy:_collect] beginning of method')
    const start = this._lastStart
    const end = new Date()
    const profiles = {}

    if (this._lambdaFunctionName) {
      console.log('[Amy:_collect] checking lambda conditions')
      if (this._profiledIntervals >= this._flushAfterIntervals &&
          (end - start) >= this._forcedInterval * this._flushAfterIntervals) {
        console.log('[Amy:_collect] resetting profiledIntervals, submitting profile')
        this._profiledIntervals = 0
        // want to continue to collect profile submission
      } else {
        console.log('[Amy:_collect] incrementing profiledIntervals, returning')
        this._profiledIntervals += 1
        console.log('[Amy:_collect] profiledIntervals:', this._profiledIntervals)
        this._capture(this._config.flushInterval)
        return
      }
    }

    try {
      for (const profiler of this._config.profilers) {
        const profile = profiler.profile()
        if (!profile) continue

        profiles[profiler.type] = await profiler.encode(profile)
        this._logger.debug(() => {
          const profileJson = JSON.stringify(profile, (key, value) => {
            return typeof value === 'bigint' ? value.toString() : value
          })
          console.log('[Amy:_collect] profileJson', profileJson)
          return `Collected ${profiler.type} profile: ` + profileJson
        })
      }

      this._capture(this._config.flushInterval)
      this._numProfiles += 1
      console.log('[Amy:_collect] submitting profile #:', this._numProfiles)
      await this._submit(profiles, start, end)
      this._logger.debug('Submitted profiles')
    } catch (err) {
      console.log('[Amy:_collect] errored:', err)
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
