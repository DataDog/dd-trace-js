'use strict'

const { EventEmitter } = require('events')
const dc = require('dc-polyfill')
const { version } = require('../../../../package.json')
const crashtracker = require('../crashtracking')
const log = require('../log')
const { buildResourceAttributes } = require('../opentelemetry/resource-attributes')
const { buildProfilingRuntime, getProfilingTags } = require('./config')
const { EventSerializer } = require('./exporters/event_serializer')
const { snapshotKinds } = require('./constants')
const { threadNamePrefix } = require('./profilers/shared')
const { isWebServerSpan, endpointNameFromTags, getStartedSpans } = require('./webspan-utils')

const profileSubmittedChannel = dc.channel('datadog:profiling:profile-submitted')
const spanFinishedChannel = dc.channel('dd-trace:span:finish')

function findWebSpan (startedSpans, spanId) {
  for (let i = startedSpans.length; --i >= 0;) {
    const ispan = startedSpans[i]
    const context = ispan.context()
    if (context._spanId === spanId) {
      if (isWebServerSpan(context.getTags())) {
        return true
      }
      spanId = context._parentId
    }
  }
  return false
}

const MISSING_SOURCE_MAPS_TOKEN = 'dd:has-missing-map-files'

function profileHasMissingSourceMaps (profile) {
  const strings = profile?.stringTable?.strings
  if (!strings) return false
  return profile.comment?.some(idx => strings[idx] === MISSING_SOURCE_MAPS_TOKEN) ?? false
}

/** @typedef {ReturnType<import('@datadog/pprof').OtelProfilesBuilder['build']>} OtlpProfilesRequest */

// The Profile.original_payload_format of the event.json in OTLP profiles, as the backend reads it
const EVENT_JSON_PAYLOAD_FORMAT = 'datadog-event-json'

/**
 * Converts attributes to OTLP key-values, leaving out values OTLP resources don't need, such as
 * undefined ones.
 *
 * @param {Record<string, unknown>} attributes
 */
function toKeyValues (attributes) {
  const keyValues = []
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'string') {
      keyValues.push({ key, value: { stringValue: value } })
    } else if (typeof value === 'number') {
      keyValues.push({ key, value: Number.isInteger(value) ? { intValue: value } : { doubleValue: value } })
    } else if (typeof value === 'boolean') {
      keyValues.push({ key, value: { boolValue: value } })
    }
  }
  return keyValues
}

function processInfo (infos, info, type) {
  if (info !== undefined) {
    infos[type] = info
  }
}

// Route pprof through the central log module so logLevel applies.
const pprofLogger = {
  trace: (...args) => log.trace(...args),
  debug: (...args) => log.debug(...args),
  info: (...args) => log.info(...args),
  warn: (...args) => log.warn(...args),
  error: (...args) => log.error(...args),
  fatal: (...args) => log.error(...args),
}

class Profiler extends EventEmitter {
  #compressionFn
  #compressionFnInitialized = false
  #compressionOptions
  #config
  #customLabelKeys = new Set()
  #enabled = false
  #endpointCounts = new Map()
  #eventSerializer
  #exporters
  #flushInterval
  #lastStart
  #otlp = false
  #profileSeq = 0
  #profilers
  #spanFinishListener
  #startFailed = false
  #stopping
  #systemInfoReport
  #currentSnapshotTags
  #timer
  #uploadCompression

  constructor () {
    super()
    this._timeoutInterval = undefined
  }

  get serverless () { return false }

  get flushInterval () {
    return this.#flushInterval
  }

  get enabled () {
    return this.#enabled
  }

  /**
   * True while a stop()'s final collection is still encoding and exporting. The profiler no
   * longer samples, but it also can not be started again until that settles and 'stopped' fires.
   */
  isStopping () {
    return this.#stopping !== undefined
  }

  /**
   * Declares the set of custom label keys that will be used with
   * {@link runWithLabels}. This is used for profile upload metadata and
   * for pprof serialization optimization (low-cardinality deduplication).
   *
   * @param {Iterable<string>} keys - Custom label key names
   */
  setCustomLabelKeys (keys) {
    this.#customLabelKeys.clear()
    for (const key of keys) {
      this.#customLabelKeys.add(key)
    }
    this.#applyCustomLabelKeys()
  }

  #applyCustomLabelKeys () {
    if (this.#profilers) {
      for (const profiler of this.#profilers) {
        profiler.setCustomLabelKeys?.(this.#customLabelKeys)
      }
    }
  }

  /**
   * Runs a function with custom profiling labels attached to wall profiler samples.
   *
   * @param {Record<string, string | number>} labels - Custom labels to attach
   * @param {function(): T} fn - Function to execute with the labels
   * @returns {T} The return value of fn
   * @template T
   */
  runWithLabels (labels, fn) {
    if (!this.#enabled || !this.#profilers) {
      return fn()
    }
    for (const profiler of this.#profilers) {
      if (profiler.runWithLabels) {
        return profiler.runWithLabels(labels, fn)
      }
    }
    return fn()
  }

  #getCompressionFn () {
    if (!this.#compressionFnInitialized) {
      this.#compressionFnInitialized = true
      try {
        const { promisify } = require('util')
        const zlib = require('zlib')
        const { method, level: clevel } = this.#uploadCompression
        switch (method) {
          case 'gzip':
            this.#compressionFn = promisify(zlib.gzip)
            if (clevel !== undefined) {
              this.#compressionOptions = {
                level: clevel,
              }
            }
            break
          case 'zstd':
            // eslint-disable-next-line n/no-unsupported-features/node-builtins
            if (typeof zlib.zstdCompress === 'function') {
              // eslint-disable-next-line n/no-unsupported-features/node-builtins
              this.#compressionFn = promisify(zlib.zstdCompress)
              if (clevel !== undefined) {
                this.#compressionOptions = {
                  params: {
                    // eslint-disable-next-line n/no-unsupported-features/node-builtins
                    [zlib.constants.ZSTD_c_compressionLevel]: clevel,
                  },
                }
              }
            } else {
              const { zstd_compress: zstdCompress } = require('@datadog/libdatadog')
              const level = clevel ?? 0 // 0 is zstd default compression level
              this.#compressionFn = (buffer) => Promise.resolve(Buffer.from(zstdCompress(buffer, level)))
            }
            break
        }
      } catch (error) {
        log.error(error)
      }
    }
    return this.#compressionFn
  }

  /**
   * @param {import('../config/config-base')} config - Tracer configuration
   */
  start (config) {
    if (this.enabled) return true
    // Initialization failures such as an unavailable native pprof binding are not expected to
    // recover within the lifetime of this process. Preserve that decision without pretending the
    // profiler is running or retrying setup on every subsequent config publication.
    if (this.#startFailed) return false

    // A prior stop()'s shutdown collection may still be encoding/exporting via #tags,
    // #exporters and #endpointCounts, which this start() would overwrite out from under it.
    // Refuse rather than queue: the caller owns the decision of what to do once the shutdown
    // settles, and by then its configuration may no longer be the one requested here. This is
    // thrown outside the setup try/catch below so it does not count as a permanent start failure.
    if (this.#stopping) {
      throw new Error('Cannot start the profiler while a shutdown collection is still in flight')
    }

    try {
      const { tags: snapshotTags, exporters, flushInterval, profilers, uploadCompression, systemInfoReport, otlp } =
        buildProfilingRuntime(config)
      this.#config = config
      this.#otlp = otlp
      this.#eventSerializer = otlp ? new EventSerializer(config) : undefined
      this.#exporters = exporters
      this.#flushInterval = flushInterval
      this.#profilers = profilers
      this.#currentSnapshotTags = snapshotTags
      // A restart is installed only after the prior shutdown collection settles, so any endpoint
      // counts left behind by a collection that produced no encodable profiles belong to the old run.
      this.#endpointCounts.clear()
      // Compression is initialized lazily and cached for a profiling run. A restarted profiler
      // must derive it again from the newly built runtime instead of retaining the prior method
      // or options.
      this.#compressionFn = undefined
      this.#compressionFnInitialized = false
      this.#compressionOptions = undefined
      this.#uploadCompression = uploadCompression
      this.#systemInfoReport = systemInfoReport
      if (this.#customLabelKeys.size > 0) {
        this.#applyCustomLabelKeys()
      }

      this._setInterval()
      // Log errors if the source map finder fails, but don't prevent the rest
      // of the profiler from running without source maps.
      let mapper
      const { setLogger, SourceMapper } = require('@datadog/pprof')
      setLogger(pprofLogger)

      if (config.DD_PROFILING_SOURCE_MAP) {
        mapper = new SourceMapper(config.DD_PROFILING_DEBUG_SOURCE_MAPS)
        mapper.loadDirectory(process.cwd())
          .then(() => {
            if (config.DD_PROFILING_DEBUG_SOURCE_MAPS) {
              const count = mapper.infoMap.size
              // eslint-disable-next-line eslint-rules/eslint-log-printf-style
              log.debug(() => {
                return count === 0
                  ? 'Found no source maps'
                  : `Found source maps for following files: [${[...mapper.infoMap.keys()].join(', ')}]`
              })
            }
          })
          .catch((error) => {
            log.error(error)
          })
      }

      // Setup above does not start any sampler runtime resources. From this point onward, #stop()
      // can safely clean up a partial start because #profilers and the rest of the runtime exist.
      this.#enabled = true
      const start = new Date()
      const nearOOMCallback = this.#nearOOMExport.bind(this)
      for (const profiler of profilers) {
        // TODO: move this out of Profiler when restoring sourcemap support
        profiler.start({
          mapper,
          nearOOMCallback,
        })
        log.debug('Started %s profiler in %s thread', profiler.type, threadNamePrefix)
      }

      if (config.DD_PROFILING_ENDPOINT_COLLECTION_ENABLED) {
        this.#spanFinishListener = this.#onSpanFinish.bind(this)
        spanFinishedChannel.subscribe(this.#spanFinishListener)
      }

      this._capture(this._timeoutInterval, start)
    } catch (error) {
      log.error(error)
      this.#startFailed = true
      if (this.enabled) {
        try {
          this.#stop()
        } catch (stopError) {
          // A cleanup failure must not leave the public running state stuck at true or escape into
          // the customer application.
          this.#enabled = false
          log.error(stopError)
        }
      }
      return false
    }

    return true
  }

  #nearOOMExport (profileType, encodedProfile, info) {
    const start = this.#lastStart
    const end = new Date()
    const infos = this.#createInitialInfos()
    processInfo(infos, info, profileType)
    this.#submit({
      [profileType]: encodedProfile,
    }, infos, start, end, this.#currentSnapshotTags, snapshotKinds.ON_OUT_OF_MEMORY)
  }

  _setInterval () {
    this._timeoutInterval = this.#flushInterval
  }

  /**
   * Stops the profiler after collecting and exporting one final profile. That export outlives
   * this call: {@link isStopping} returns true and start() throws until it settles, at which
   * point a 'stopped' event is emitted.
   */
  stop () {
    if (!this.enabled) return

    // collect and export current profiles
    // once collect returns, profilers can be safely stopped
    this.#stopping = this._collect(snapshotKinds.ON_SHUTDOWN, false)
      .catch(error => {
        // _collect() contains its own failures, but its cleanup can still throw. Nothing awaits
        // this shutdown chain, so consume and log that failure instead of leaking a rejection.
        log.error(error)
      })
      .finally(() => {
        this.#stopping = undefined
        // Nothing awaits this promise, so a listener throwing here would become an unhandled
        // rejection instead of reaching whoever requested the stop.
        try {
          this.emit('stopped')
        } catch (error) {
          log.error(error)
        }
      })
    this.#stop()
  }

  #stop () {
    if (!this.enabled) return

    this.#enabled = false

    if (this.#spanFinishListener !== undefined) {
      spanFinishedChannel.unsubscribe(this.#spanFinishListener)
      this.#spanFinishListener = undefined
    }

    for (const profiler of this.#profilers) {
      profiler.stop()
      log.debug('Stopped %s profiler in %s thread', profiler.type, threadNamePrefix)
    }

    clearTimeout(this.#timer)
    this.#timer = undefined
  }

  _capture (timeout, start) {
    if (!this.enabled) return
    this.#lastStart = start
    if (this.#timer && timeout === this._timeoutInterval) {
      this.#timer.refresh()
    } else {
      this.#timer = setTimeout(() => this._collect(snapshotKinds.PERIODIC), timeout)
      this.#timer.unref?.()
    }
  }

  #onSpanFinish (span) {
    const context = span.context()
    const tags = context.getTags()
    if (!isWebServerSpan(tags)) return

    const endpointName = endpointNameFromTags(tags)
    // Make sure this is the outermost web span, just in case so we don't overcount
    if (!endpointName || findWebSpan(getStartedSpans(context), context._parentId)) return

    let counter = this.#endpointCounts.get(endpointName)
    if (counter === undefined) {
      counter = { count: 1 }
      this.#endpointCounts.set(endpointName, counter)
    } else {
      counter.count++
    }
  }

  #createInitialInfos () {
    return {
      serverless: this.serverless,
      settings: this.#systemInfoReport,
      hasMissingSourceMaps: false,
    }
  }

  async _collect (snapshotKind, restart = true) {
    if (!this.enabled) return

    try {
      if (this.#profilers.length === 0) {
        throw new Error('No profile types configured.')
      }

      const startDate = this.#lastStart
      const endDate = new Date()
      const snapshotTags = this.#currentSnapshotTags
      const profiles = []
      // With OTLP, all profiles of the cycle go into one request, sharing its dictionary
      const otlpBuilder = this.#otlp ? this.#createOtlpBuilder() : undefined

      crashtracker.withProfilerSerializing(() => {
        // collect profiles synchronously so that profilers can be safely stopped asynchronously
        for (const profiler of this.#profilers) {
          const info = profiler.getInfo()
          const profile = otlpBuilder === undefined
            ? profiler.profile(restart, startDate, endDate)
            : profiler.visit(restart, otlpBuilder.visitor())
          if (!restart) {
            log.debug('Stopped %s profiler in %s thread', profiler.type, threadNamePrefix)
          }
          if (!profile) continue
          profiles.push({ profiler, profile, info })
        }
      })

      if (restart) {
        this.#currentSnapshotTags = getProfilingTags(this.#config)
        this._capture(this._timeoutInterval, endDate)
      }

      if (otlpBuilder !== undefined) {
        if (profiles.length > 0) {
          await this.#submitOtlp(otlpBuilder, profiles, startDate, endDate, snapshotTags, snapshotKind)
          profileSubmittedChannel.publish()
          log.debug('Submitted OTLP profiles')
        }
        return
      }

      let hasEncoded = false

      const encodedProfiles = {}
      const infos = this.#createInitialInfos()
      const compressionFn = this.#getCompressionFn()

      // encode and export asynchronously
      await Promise.all(profiles.map(async ({ profiler, profile, info }) => {
        try {
          const encoded = await profiler.encode(profile)
          const compressed = encoded instanceof Buffer && compressionFn !== undefined
            ? await compressionFn(encoded, this.#compressionOptions)
            : encoded
          encodedProfiles[profiler.type] = compressed
          if (profileHasMissingSourceMaps(profile)) {
            infos.hasMissingSourceMaps = true
          }
          processInfo(infos, info, profiler.type)
          // eslint-disable-next-line eslint-rules/eslint-log-printf-style
          log.debug(() => {
            const profileJson = JSON.stringify(profile, (_, value) => {
              return typeof value === 'bigint' ? value.toString() : value
            })
            return `Collected ${profiler.type} profile: ` + profileJson
          })
          hasEncoded = true
        } catch (error) {
          // If encoding one of the profile types fails, we should still try to
          // encode and submit the other profile types.
          log.error(error)
        }
      }))

      if (hasEncoded) {
        await this.#submit(encodedProfiles, infos, startDate, endDate, snapshotTags, snapshotKind)
        profileSubmittedChannel.publish()
        log.debug('Submitted profiles')
      }
    } catch (error) {
      log.error(error)
      this.#stop()
    }
  }

  #createOtlpBuilder () {
    const { OtelProfilesBuilder } = require('@datadog/pprof')
    return new OtelProfilesBuilder({
      resourceAttributes: toKeyValues({
        ...buildResourceAttributes(this.#config),
        'telemetry.sdk.name': 'datadog',
        'telemetry.sdk.language': 'nodejs',
        'telemetry.sdk.version': version,
        // Tells the backend to rebuild the upload that dd-trace-js sends without OTLP
        'datadog.family': 'node',
      }),
      scope: { name: 'dd-trace-js', version },
    })
  }

  /**
   * Submits a cycle's profiles as one OTLP request: the profilers' visits, with the event.json that
   * goes with pprof uploads as every profile's original payload.
   *
   * @param {import('@datadog/pprof').OtelProfilesBuilder} builder
   * @param {Array<{ profiler: { type: string }, profile: { hasMissingMapFiles: boolean }, info: unknown }>} visits
   * @param {Date} start
   * @param {Date} end
   * @param {Record<string, string|number|boolean|undefined>} snapshotTags
   * @param {string} snapshotKind
   */
  #submitOtlp (builder, visits, start, end, snapshotTags, snapshotKind) {
    const infos = this.#createInitialInfos()
    const types = []
    for (const { profiler, profile, info } of visits) {
      types.push(profiler.type)
      if (profile.hasMissingMapFiles) {
        infos.hasMissingSourceMaps = true
      }
      processInfo(infos, info, profiler.type)
    }
    return this.#submit({}, infos, start, end, snapshotTags, snapshotKind, { request: builder.build(), types })
  }

  /**
   * Encodes an OTLP request, with the cycle's event.json as every profile's original payload.
   *
   * @param {OtlpProfilesRequest} request
   * @param {string[]} types - The profile types in the request, for the event's attachments
   * @param {object} exportSpec - The cycle's export, as for pprof uploads
   * @returns {Promise<Buffer>}
   */
  async #encodeOtlp (request, types, exportSpec) {
    const attachments = Object.fromEntries(types.map(type => [type, true]))
    const event = Buffer.from(this.#eventSerializer.getEventJSON({ ...exportSpec, profiles: attachments }))
    for (const resourceProfiles of request.resourceProfiles) {
      for (const scopeProfiles of resourceProfiles.scopeProfiles) {
        for (const profile of scopeProfiles.profiles) {
          profile.originalPayloadFormat = EVENT_JSON_PAYLOAD_FORMAT
          profile.originalPayload = event
        }
      }
    }
    return Buffer.from(await request.encodeAsync())
  }

  /**
   * @param {Record<string, Buffer|string>} profiles
   * @param {Record<string, unknown>} infos
   * @param {Date} start
   * @param {Date} end
   * @param {Record<string, string|number|boolean|undefined>} snapshotTags
   * @param {string} snapshotKind
   * @param {{ request: OtlpProfilesRequest, types: string[] }} [otlp] - The
   *   cycle's OTLP request, unencoded, in place of pprof profiles
   */
  async #submit (profiles, infos, start, end, snapshotTags, snapshotKind, otlp) {
    // Flatten endpoint counts
    const endpointCounts = {}
    for (const [endpoint, { count }] of this.#endpointCounts) {
      endpointCounts[endpoint] = count
    }
    this.#endpointCounts.clear()

    snapshotTags.snapshot = snapshotKind
    snapshotTags.profile_seq = this.#profileSeq++
    const customAttributes = this.#customLabelKeys.size > 0
      ? [...this.#customLabelKeys]
      : undefined
    const exportSpec = { profiles, infos, start, end, tags: snapshotTags, endpointCounts, customAttributes }
    if (otlp !== undefined) {
      try {
        exportSpec.otlp = await this.#encodeOtlp(otlp.request, otlp.types, exportSpec)
      } catch (error) {
        log.error('Failed to encode OTLP profiles', error)
        return
      }
    }
    const tasks = this.#exporters.map(exporter =>
      exporter.export(exportSpec).catch(error => {
        log.warn(error)
      })
    )

    await Promise.all(tasks)
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

  get serverless () { return true }

  get profiledIntervals () {
    return this.#profiledIntervals
  }

  _setInterval () {
    this._timeoutInterval = this.#interval * 1000
    this.#flushAfterIntervals = this.flushInterval / 1000
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
