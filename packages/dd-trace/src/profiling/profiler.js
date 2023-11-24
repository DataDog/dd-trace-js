'use strict'

const { EventEmitter } = require('events')
const { Config } = require('./config')
const { snapshotKinds } = require('./constants')

function maybeSourceMap (sourceMap, SourceMapper, debug) {
  if (!sourceMap) return
  return SourceMapper.create([
    process.cwd()
  ], debug)
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
      if (options.logger) {
        options.logger.error(err)
      }
      return false
    })
  }

  async _start (options) {
    if (this._enabled) return true

    const config = this._config = new Config(options)
    if (!config.enabled) return false

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
      this._logger.error(err)
    }

    try {
      for (const profiler of config.profilers) {
        // TODO: move this out of Profiler when restoring sourcemap support
        profiler.start({
          mapper,
          nearOOMCallback: this._nearOOMExport.bind(this)
        })
        this._logger.debug(`Started ${profiler.type} profiler`)
      }

      this._capture(this._timeoutInterval)
      return true
    } catch (e) {
      this._logger.error(e)
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
    this._collect(snapshotKinds.ON_SHUTDOWN)
    this._stop()
  }

  _stop () {
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
      this._timer = setTimeout(() => this._collect(snapshotKinds.PERIODIC), timeout)
      this._timer.unref()
    } else {
      this._timer.refresh()
    }
  }

  async _collect (snapshotKind) {
    if (!this._enabled) return

    const start = this._lastStart
    const end = new Date()
    const profiles = []
    const encodedProfiles = {}

    try {
      // collect profiles synchronously so that profilers can be safely stopped asynchronously
      for (const profiler of this._config.profilers) {
        const profile = profiler.profile()
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

      this._capture(this._timeoutInterval)
      await this._submit(encodedProfiles, start, end, snapshotKind)
      this._logger.debug('Submitted profiles')
    } catch (err) {
      this._logger.error(err)
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

  async _collect (snapshotKind) {
    if (this._profiledIntervals >= this._flushAfterIntervals) {
      this._profiledIntervals = 0
      await super._collect(snapshotKind)
    } else {
      this._profiledIntervals += 1
      this._capture(this._timeoutInterval)
      // Don't submit profile until 65 (flushAfterIntervals) intervals have elapsed
    }
  }
}

module.exports = { Profiler, ServerlessProfiler }
