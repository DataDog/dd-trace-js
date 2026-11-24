'use strict'

const { EventEmitter } = require('events')
const { setImmediate: yieldToEventLoop } = require('node:timers/promises')
const dc = require('dc-polyfill')
const { version } = require('../../../../package.json')
const crashtracker = require('../crashtracking')
const log = require('../log')
const { transformAttributes } = require('../opentelemetry/otlp/attributes')
const { buildResourceAttributes } = require('../opentelemetry/resource-attributes')
const { buildProfilingRuntime, getProfilingTags } = require('./config')
const { snapshotKinds } = require('./constants')
const { encodeProfileAsync, threadNamePrefix } = require('./profilers/shared')
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

/** @typedef {import('@datadog/pprof').CapturedProfile} CapturedProfile */
/** @typedef {import('./config').ProfilingProfiler} ProfilingProfiler */
/** @typedef {{ profiler: ProfilingProfiler, captured: CapturedProfile, info: unknown }} Capture */
/**
 * Profiles that are built together, and the builder of their encoded payload: a pprof or an OTLP one.
 *
 * @typedef {{
 *   captures: Capture[],
 *   builder: import('@datadog/pprof').PprofProfileBuilder | import('@datadog/pprof').OtelProfilesBuilder,
 * }} Batch
 */

/**
 * The OTLP resource of the profiles: the attributes the other OTLP signals send, the SDK's, and the process's, which
 * pprof uploads have as the process_id and runtime_version tags, leaving out unset values.
 *
 * @param {import('../config/config-base')} config
 */
function buildOtlpResourceAttributes (config) {
  const attributes = {
    ...buildResourceAttributes(config),
    'telemetry.sdk.name': 'datadog',
    'telemetry.sdk.language': 'nodejs',
    'telemetry.sdk.version': version,
    'process.pid': process.pid,
    'process.runtime.name': 'nodejs',
    // Without process.version's "v", as the semantic conventions and the OpenTelemetry SDK have it
    'process.runtime.version': process.versions.node,
  }
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) {
      delete attributes[key]
    }
  }
  return transformAttributes(attributes)
}

// The eBPF host profiler's names of the sample types it shares with pprof profiles, so OTLP profiles of a measure have
// one name whichever profiler made them. Wall time, which it doesn't have, is named the same way as CPU time.
const OTLP_SAMPLE_TYPE_NAMES = new Map([
  ['wall/nanoseconds', 'wall-time'],
  ['cpu/nanoseconds', 'cpu-time'],
  ['inuse_objects/count', 'heap-live-samples'],
  ['inuse_space/bytes', 'heap-live-size'],
  ['alloc_objects/count', 'alloc-samples'],
  ['alloc_space/bytes', 'alloc-size'],
])

/**
 * @param {{ type: string, unit: string }} sampleType
 * @returns {{ type: string, unit: string }}
 */
function renameOtlpSampleType ({ type, unit }) {
  return { type: OTLP_SAMPLE_TYPE_NAMES.get(`${type}/${unit}`) ?? type, unit }
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
   * Types of the running profilers (e.g. 'wall', 'space', 'events'), plus 'cpu' when the wall
   * profiler also collects CPU time and 'allocations' when the space profiler also collects
   * allocations. Empty while the profiler isn't running.
   *
   * @returns {string[]}
   */
  getRunningTypes () {
    if (!this.#enabled) return []
    const types = []
    for (const profiler of this.#profilers) {
      types.push(profiler.type)
      if (profiler.collectsCpuTime) types.push('cpu')
      if (profiler.collectsAllocations) types.push('allocations')
    }
    return types
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
      const captures = []
      crashtracker.withProfilerSerializing(() => {
        // Capture profiles synchronously so that profilers can be safely stopped asynchronously. Only
        // what has to happen now does; visiting the profiles, which normalizes them, is deferred.
        for (const profiler of this.#profilers) {
          const info = profiler.getInfo()
          const captured = profiler.capture(restart, startDate, endDate)
          if (!restart) {
            log.debug('Stopped %s profiler in %s thread', profiler.type, threadNamePrefix)
          }
          if (!captured) continue
          captures.push({ profiler, captured, info })
        }
      })

      if (restart) {
        this.#currentSnapshotTags = getProfilingTags(this.#config)
        this._capture(this._timeoutInterval, endDate)
      }

      if (captures.length === 0) return

      await this.#submitCaptures(captures, startDate, endDate, snapshotTags, snapshotKind)
    } catch (error) {
      log.error(error)
      this.#stop()
    }
  }

  #createOtlpBuilder () {
    const { OtelProfilesBuilder } = require('@datadog/pprof')
    return new OtelProfilesBuilder({
      resourceAttributes: buildOtlpResourceAttributes(this.#config),
      scope: { name: 'dd-trace-js', version },
      // Only frames for server-side unminification carry their columns, as in pprof uploads
      columns: 'missing-source-maps',
      renameSampleType: renameOtlpSampleType,
    })
  }

  /**
   * Submits a cycle's captured profiles, built in batches, each with its own builder: as pprof, a
   * batch for each profile, built as its profiler's pprofBuilderOptions tell; as OTLP, one batch, a
   * request in which the profiles share the dictionary. Each visit of a profile into its batch's
   * builder, which normalizes it, and each batch's building and encoding start after a yield to the
   * event loop, as they start with synchronous work; encodings then proceed concurrently. A profile
   * whose visit fails is left out, and so is a batch whose encoding fails, with their profilers' infos.
   *
   * @param {Capture[]} captures
   * @param {Date} start
   * @param {Date} end
   * @param {Record<string, string|number|boolean|undefined>} snapshotTags
   * @param {string} snapshotKind
   */
  async #submitCaptures (captures, start, end, snapshotTags, snapshotKind) {
    // OTLP requests aren't compressed yet
    const compressionFn = this.#otlp ? undefined : this.#getCompressionFn()
    const encodings = []
    const encodedBatches = []
    for (const batch of this.#createBatches(captures)) {
      // eslint-disable-next-line no-await-in-loop -- Visits must yield, between them and to the encoders.
      const visit = await this.#visitBatch(batch)
      if (visit === undefined) continue
      // eslint-disable-next-line no-await-in-loop -- Encoder starts must yield, not their entire async tasks.
      await yieldToEventLoop()
      encodings.push(this.#encodeBatch(batch, compressionFn).then(
        encoded => { encodedBatches.push({ batch, visit, encoded }) },
        // If one of the batches fails, we should still try to encode and submit the others.
        error => { log.error(error) }
      ))
    }
    await Promise.all(encodings)
    if (encodedBatches.length === 0) return

    const infos = this.#createInitialInfos()
    const profiles = {}
    let otlp
    for (const { batch, visit, encoded } of encodedBatches) {
      if (visit.hasMissingMapFiles) {
        infos.hasMissingSourceMaps = true
      }
      for (const { profiler, info } of visit.captures) {
        processInfo(infos, info, profiler.type)
      }
      if (this.#otlp) {
        otlp = encoded
      } else {
        profiles[batch.captures[0].profiler.type] = encoded
      }
    }
    await this.#submit(profiles, infos, start, end, snapshotTags, snapshotKind, otlp)
    profileSubmittedChannel.publish()
    log.debug(this.#otlp ? 'Submitted OTLP profiles' : 'Submitted profiles')
  }

  /**
   * @param {Capture[]} captures
   * @returns {Batch[]}
   */
  #createBatches (captures) {
    if (this.#otlp) {
      return [{ captures, builder: this.#createOtlpBuilder() }]
    }
    const { PprofProfileBuilder } = require('@datadog/pprof')
    return captures.map(capture => ({
      captures: [capture],
      builder: new PprofProfileBuilder(capture.profiler.pprofBuilderOptions),
    }))
  }

  /**
   * Visits a batch's profiles into its builder, each after a yield to the event loop. A profile whose
   * visit fails is left out: the OTLP builder only adds a visit's profiles when it completes, and a pprof
   * batch has no other profile.
   *
   * @param {Batch} batch
   * @returns {Promise<{ captures: Capture[], hasMissingMapFiles: boolean } | undefined>} the captures
   *   that were visited, or undefined if none was
   */
  async #visitBatch ({ captures, builder }) {
    const visited = []
    let hasMissingMapFiles = false
    for (const capture of captures) {
      // eslint-disable-next-line no-await-in-loop -- Each visit is synchronous work to separate.
      await yieldToEventLoop()
      try {
        if (capture.captured.visit(builder.visitor()).hasMissingMapFiles) {
          hasMissingMapFiles = true
        }
        visited.push(capture)
      } catch (error) {
        log.error(error)
      }
    }
    return visited.length === 0 ? undefined : { captures: visited, hasMissingMapFiles }
  }

  /**
   * Builds and encodes a batch, and compresses it with the compression function, if any.
   *
   * @param {Batch} batch
   * @param {((buffer: Buffer, options: unknown) => Promise<Buffer>) | undefined} compressionFn
   * @returns {Promise<Buffer>}
   */
  async #encodeBatch ({ captures, builder }, compressionFn) {
    const built = builder.build()
    const encoded = await encodeProfileAsync(built)
    const compressed = compressionFn === undefined
      ? encoded
      : await compressionFn(encoded, this.#compressionOptions)
    if (!this.#otlp) {
      // eslint-disable-next-line eslint-rules/eslint-log-printf-style
      log.debug(() => {
        const profileJson = JSON.stringify(built, (_, value) => {
          return typeof value === 'bigint' ? value.toString() : value
        })
        return `Collected ${captures[0].profiler.type} profile: ` + profileJson
      })
    }
    return compressed
  }

  /**
   * @param {Record<string, Buffer|string>} profiles
   * @param {Record<string, unknown>} infos
   * @param {Date} start
   * @param {Date} end
   * @param {Record<string, string|number|boolean|undefined>} snapshotTags
   * @param {string} snapshotKind
   * @param {Buffer} [otlp] - The cycle's encoded OTLP request, in place of pprof profiles
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
      exportSpec.otlp = otlp
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
