'use strict'

const { EventEmitter } = require('events')
const { Config } = require('./config')
const { snapshotKinds } = require('./constants')
const { threadNamePrefix } = require('./profilers/shared')
const { isWebServerSpan, endpointNameFromTags, getStartedSpans } = require('./webspan-utils')
const dc = require('dc-polyfill')
const crashtracker = require('../crashtracking')

const { promisify } = require('util')
const zlib = require('zlib')

const profileSubmittedChannel = dc.channel('datadog:profiling:profile-submitted')
const spanFinishedChannel = dc.channel('dd-trace:span:finish')

function maybeSourceMap (sourceMap, SourceMapper, debug) {
  if (!sourceMap) return
  return SourceMapper.create([
    process.cwd()
  ], debug)
}

function logError (logger, ...args) {
  if (logger) {
    logger.error(...args)
  }
}

function findWebSpan (startedSpans, spanId) {
  for (let i = startedSpans.length; --i >= 0;) {
    const ispan = startedSpans[i]
    const context = ispan.context()
    if (context._spanId === spanId) {
      if (isWebServerSpan(context._tags)) {
        return true
      }
      spanId = context._parentId
    }
  }
  return false
}

class Profiler extends EventEmitter {
  #compressionFn
  #compressionOptions
  #enabled = false
  #endpointCounts = new Map()
  #lastStart
  #logger
  #profileSeq = 0
  #spanFinishListener
  #timer

  constructor () {
    super()
    this._config = undefined
    this._timeoutInterval = undefined
  }

  start (options) {
    return this._start(options).catch((err) => {
      logError(options.logger, 'Error starting profiler. For troubleshooting tips, see ' +
        '<https://dtdg.co/nodejs-profiler-troubleshooting>', err)
      return false
    })
  }

  get enabled () {
    return this.#enabled
  }

  #logError (err) {
    logError(this.#logger, err)
  }

  async _start (options) {
    if (this.enabled) return true

    const config = this._config = new Config(options)

    this.#logger = config.logger
    this.#enabled = true
    this._setInterval()

    // Log errors if the source map finder fails, but don't prevent the rest
    // of the profiler from running without source maps.
    let mapper
    try {
      const { setLogger, SourceMapper } = require('@datadog/pprof')
      setLogger(config.logger)

      mapper = await maybeSourceMap(config.sourceMap, SourceMapper, config.debugSourceMaps)
      if (config.sourceMap && config.debugSourceMaps) {
        this.#logger.debug(() => {
          return mapper.infoMap.size === 0
            ? 'Found no source maps'
            : `Found source maps for following files: [${[...mapper.infoMap.keys()].join(', ')}]`
        })
      }

      const clevel = config.uploadCompression.level
      switch (config.uploadCompression.method) {
        case 'gzip':
          this.#compressionFn = promisify(zlib.gzip)
          if (clevel !== undefined) {
            this.#compressionOptions = {
              level: clevel
            }
          }
          break
        case 'zstd':
          if (typeof zlib.zstdCompress === 'function') {
            this.#compressionFn = promisify(zlib.zstdCompress)
            if (clevel !== undefined) {
              this.#compressionOptions = {
                params: {
                  [zlib.constants.ZSTD_c_compressionLevel]: clevel
                }
              }
            }
          } else {
            const zstdCompress = require('@datadog/libdatadog').load('datadog-js-zstd').zstd_compress
            const level = clevel ?? 0 // 0 is zstd default compression level
            this.#compressionFn = (buffer) => Promise.resolve(Buffer.from(zstdCompress(buffer, level)))
          }
          break
      }
    } catch (err) {
      this.#logError(err)
    }

    try {
      const start = new Date()
      const nearOOMCallback = this.#nearOOMExport.bind(this)
      for (const profiler of config.profilers) {
        // TODO: move this out of Profiler when restoring sourcemap support
        profiler.start({
          mapper,
          nearOOMCallback
        })
        this.#logger.debug(`Started ${profiler.type} profiler in ${threadNamePrefix} thread`)
      }

      if (config.endpointCollectionEnabled) {
        this.#spanFinishListener = this.#onSpanFinish.bind(this)
        spanFinishedChannel.subscribe(this.#spanFinishListener)
      }

      this._capture(this._timeoutInterval, start)
      return true
    } catch (e) {
      this.#logError(e)
      this.#stop()
      return false
    }
  }

  #nearOOMExport (profileType, encodedProfile) {
    const start = this.#lastStart
    const end = new Date()
    this.#submit({
      [profileType]: encodedProfile
    }, start, end, snapshotKinds.ON_OUT_OF_MEMORY)
  }

  _setInterval () {
    this._timeoutInterval = this._config.flushInterval
  }

  stop () {
    if (!this.enabled) return

    // collect and export current profiles
    // once collect returns, profilers can be safely stopped
    this._collect(snapshotKinds.ON_SHUTDOWN, false)
    this.#stop()
  }

  #stop () {
    if (!this.enabled) return

    this.#enabled = false

    if (this.#spanFinishListener !== undefined) {
      spanFinishedChannel.unsubscribe(this.#spanFinishListener)
      this.#spanFinishListener = undefined
    }

    for (const profiler of this._config.profilers) {
      profiler.stop()
      this.#logger.debug(`Stopped ${profiler.type} profiler in ${threadNamePrefix} thread`)
    }

    clearTimeout(this.#timer)
    this.#timer = undefined
  }

  _capture (timeout, start) {
    if (!this.enabled) return
    this.#lastStart = start
    if (!this.#timer || timeout !== this._timeoutInterval) {
      this.#timer = setTimeout(() => this._collect(snapshotKinds.PERIODIC), timeout)
      this.#timer.unref()
    } else {
      this.#timer.refresh()
    }
  }

  #onSpanFinish (span) {
    const context = span.context()
    const tags = context._tags
    if (!isWebServerSpan(tags)) return

    const endpointName = endpointNameFromTags(tags)
    if (!endpointName) return

    // Make sure this is the outermost web span, just in case so we don't overcount
    if (findWebSpan(getStartedSpans(context), context._parentId)) return

    let counter = this.#endpointCounts.get(endpointName)
    if (counter === undefined) {
      counter = { count: 1 }
      this.#endpointCounts.set(endpointName, counter)
    } else {
      counter.count++
    }
  }

  async _collect (snapshotKind, restart = true) {
    if (!this.enabled) return

    const startDate = this.#lastStart
    const endDate = new Date()
    const profiles = []
    const encodedProfiles = {}

    try {
      if (this._config.profilers.length === 0) {
        throw new Error('No profile types configured.')
      }

      crashtracker.withProfilerSerializing(() => {
        // collect profiles synchronously so that profilers can be safely stopped asynchronously
        for (const profiler of this._config.profilers) {
          const profile = profiler.profile(restart, startDate, endDate)
          if (!restart) {
            this.#logger.debug(`Stopped ${profiler.type} profiler in ${threadNamePrefix} thread`)
          }
          if (!profile) continue
          profiles.push({ profiler, profile })
        }
      })

      if (restart) {
        this._capture(this._timeoutInterval, endDate)
      }

      let hasEncoded = false

      // encode and export asynchronously
      await Promise.all(profiles.map(async ({ profiler, profile }) => {
        try {
          const encoded = await profiler.encode(profile)
          const compressed = encoded instanceof Buffer && this.#compressionFn !== undefined
            ? await this.#compressionFn(encoded, this.#compressionOptions)
            : encoded
          encodedProfiles[profiler.type] = compressed
          this.#logger.debug(() => {
            const profileJson = JSON.stringify(profile, (key, value) => {
              return typeof value === 'bigint' ? value.toString() : value
            })
            return `Collected ${profiler.type} profile: ` + profileJson
          })
          hasEncoded = true
        } catch (err) {
          // If encoding one of the profile types fails, we should still try to
          // encode and submit the other profile types.
          this.#logError(err)
        }
      }))

      if (hasEncoded) {
        await this.#submit(encodedProfiles, startDate, endDate, snapshotKind)
        profileSubmittedChannel.publish()
        this.#logger.debug('Submitted profiles')
      }
    } catch (err) {
      this.#logError(err)
      this.#stop()
    }
  }

  #submit (profiles, start, end, snapshotKind) {
    const { tags } = this._config

    // Flatten endpoint counts
    const endpointCounts = {}
    for (const [endpoint, { count }] of this.#endpointCounts) {
      endpointCounts[endpoint] = count
    }
    this.#endpointCounts.clear()

    tags.snapshot = snapshotKind
    tags.profile_seq = this.#profileSeq++
    const exportSpec = { profiles, start, end, tags, endpointCounts }
    const tasks = this._config.exporters.map(exporter =>
      exporter.export(exportSpec).catch(err => {
        if (this.#logger) {
          this.#logger.warn(err)
        }
      })
    )

    return Promise.all(tasks)
  }
}

class ServerlessProfiler extends Profiler {
  #profiledIntervals = 0
  #interval = 1 // seconds
  #flushAfterIntervals

  constructor () {
    super()
    this.#profiledIntervals = 0
    this.#interval = 1
    this.#flushAfterIntervals = undefined
  }

  get profiledIntervals () {
    return this.#profiledIntervals
  }

  _setInterval () {
    this._timeoutInterval = this.#interval * 1000
    this.#flushAfterIntervals = this._config.flushInterval / 1000
  }

  async _collect (snapshotKind, restart = true) {
    if (this.#profiledIntervals >= this.#flushAfterIntervals || !restart) {
      this.#profiledIntervals = 0
      await super._collect(snapshotKind, restart)
    } else {
      this.#profiledIntervals += 1
      this._capture(this._timeoutInterval, new Date())
      // Don't submit profile until 65 (flushAfterIntervals) intervals have elapsed
    }
  }
}

module.exports = { Profiler, ServerlessProfiler }
