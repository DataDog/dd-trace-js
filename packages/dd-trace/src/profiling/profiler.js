'use strict'

const { EventEmitter } = require('events')
const { Config } = require('./config')
const { snapshotKinds } = require('./constants')
const { threadNamePrefix } = require('./profilers/shared')
const dc = require('dc-polyfill')
const telemetryLog = dc.channel('datadog:telemetry:log')

const profileSubmittedChannel = dc.channel('datadog:profiling:profile-submitted')

function maybeSourceMap (sourceMap, SourceMapper, debug) {
  if (!sourceMap) return
  return SourceMapper.create([
    process.cwd()
  ], debug)
}

function logError (logger, err) {
  if (logger) {
    logger.error(err)
  }
  if (telemetryLog.hasSubscribers) {
    telemetryLog.publish({
      message: err.message,
      level: 'ERROR',
      stack_trace: err.stack
    })
  }
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
    return this._start(options).catch((err) => {
      logError(options.logger, err)
      return false
    })
  }

  _logError (err) {
    logError(this._logger, err)
  }

  async _start (options) {
    if (this._enabled) return true

    const config = this._config = new Config(options)
    if (!config.enabled && !config.heuristicsEnabled) return false

    this._logger = config.logger
    this._enabled = true
    this._setInterval()

    // Log errors if the source map finder fails, but don't prevent the rest
    // of the profiler from running without source maps.
    let mapper
    try {
      const { setLogger, SourceMapper } = require('@datadog/pprof')
      setLogger(config.logger)

      mapper = await maybeSourceMap(config.sourceMap, SourceMapper, config.debugSourceMaps)
      if (config.SourceMap && config.debugSourceMaps) {
        this._logger.debug(() => {
          return mapper.infoMap.size === 0
            ? 'Found no source maps'
            : `Found source maps for following files: [${Array.from(mapper.infoMap.keys()).join(', ')}]`
        })
      }
    } catch (err) {
      this._logError(err)
    }

    try {
      const start = new Date()
      for (const profiler of config.profilers) {
        // TODO: move this out of Profiler when restoring sourcemap support
        profiler.start({
          mapper,
          nearOOMCallback: this._nearOOMExport.bind(this)
        })
        this._logger.debug(`Started ${profiler.type} profiler in ${threadNamePrefix} thread`)
      }

      this._capture(this._timeoutInterval, start)
      return true
    } catch (e) {
      this._logError(e)
      this._stop()
      return false
    }
  }

  _nearOOMExport (profileType, encodedProfile) {
    const start = this._lastStart
    const end = new Date()
    this._submit({
      [profileType]: encodedProfile
    }, start, end, snapshotKinds.ON_OUT_OF_MEMORY)
  }

  _setInterval () {
    this._timeoutInterval = this._config.flushInterval
  }

  async stop () {
    if (!this._enabled) return

    // collect and export current profiles
    // once collect returns, profilers can be safely stopped
    this._collect(snapshotKinds.ON_SHUTDOWN, false)
    this._stop()
  }

  _stop () {
    if (!this._enabled) return

    this._enabled = false

    for (const profiler of this._config.profilers) {
      profiler.stop()
      this._logger.debug(`Stopped ${profiler.type} profiler in ${threadNamePrefix} thread`)
    }

    clearTimeout(this._timer)
    this._timer = undefined
  }

  _capture (timeout, start) {
    if (!this._enabled) return
    this._lastStart = start
    if (!this._timer || timeout !== this._timeoutInterval) {
      this._timer = setTimeout(() => this._collect(snapshotKinds.PERIODIC), timeout)
      this._timer.unref()
    } else {
      this._timer.refresh()
    }
  }

  async _collect (snapshotKind, restart = true) {
    if (!this._enabled) return

    const startDate = this._lastStart
    const endDate = new Date()
    const profiles = []
    const encodedProfiles = {}

    try {
      // collect profiles synchronously so that profilers can be safely stopped asynchronously
      for (const profiler of this._config.profilers) {
        const profile = profiler.profile(restart, startDate, endDate)
        if (!restart) {
          this._logger.debug(`Stopped ${profiler.type} profiler in ${threadNamePrefix} thread`)
        }
        if (!profile) continue
        profiles.push({ profiler, profile })
      }

      // encode and export asynchronously
      for (const { profiler, profile } of profiles) {
        encodedProfiles[profiler.type] = await profiler.encode(profile)
        this._logger.debug(() => {
          const profileJson = JSON.stringify(profile, (key, value) => {
            return typeof value === 'bigint' ? value.toString() : value
          })
          return `Collected ${profiler.type} profile: ` + profileJson
        })
      }

      if (restart) {
        this._capture(this._timeoutInterval, endDate)
      }
      await this._submit(encodedProfiles, startDate, endDate, snapshotKind)
      profileSubmittedChannel.publish()
      this._logger.debug('Submitted profiles')
    } catch (err) {
      this._logError(err)
      this._stop()
    }
  }

  _submit (profiles, start, end, snapshotKind) {
    if (!Object.keys(profiles).length) {
      return Promise.reject(new Error('No profiles to submit'))
    }
    const { tags } = this._config
    const tasks = []

    tags.snapshot = snapshotKind
    for (const exporter of this._config.exporters) {
      const task = exporter.export({ profiles, start, end, tags })
        .catch(err => this._logError(err))

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

  async _collect (snapshotKind, restart = true) {
    if (this._profiledIntervals >= this._flushAfterIntervals || !restart) {
      this._profiledIntervals = 0
      await super._collect(snapshotKind, restart)
    } else {
      this._profiledIntervals += 1
      this._capture(this._timeoutInterval, new Date())
      // Don't submit profile until 65 (flushAfterIntervals) intervals have elapsed
    }
  }
}

module.exports = { Profiler, ServerlessProfiler }
