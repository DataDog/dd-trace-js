'use strict'

const { performance, constants, PerformanceObserver } = require('perf_hooks')
const { availableParallelism, effectiveLibuvThreadCount } = require('../libuv-size')
const { SAMPLING_INTERVAL } = require('../constants')
const { END_TIMESTAMP_LABEL, SPAN_ID_LABEL, LOCAL_ROOT_SPAN_ID_LABEL, encodeProfileAsync } = require('./shared')
const PoissonProcessSamplingFilter = require('./poisson')
// perf_hooks uses millis, with fractional part representing nanos. We emit nanos into the pprof file.
const MS_TO_NS = 1_000_000
// The number of sampling intervals that need to pass before we reset the Poisson process sampling instant.
const POISSON_RESET_FACTOR = 2

/** @typedef {import('../../config/config-base')} TracerConfig */

// While this is an "events profiler", meaning it emits a profile based on events observed as
// perf_hooks events, the emitted profile uses the type "timeline".
const TIMELINE_SAMPLE_TYPE = { type: 'timeline', unit: 'nanoseconds' }

// A synthetic single-frame stack for timeline samples: profiles need samples to have one. Its name is
// a single space, which displays as blank, as frames with an empty name get a placeholder name.
const TIMELINE_FRAME = { name: ' ', file: '', missingMapFile: false }

const dateOffset = BigInt(Math.round(performance.timeOrigin * MS_TO_NS))

/**
 * @typedef {import('@datadog/pprof').SampleLabel} SampleLabel
 * @typedef {import('@datadog/pprof').ProfileVisitor} ProfileVisitor
 * @typedef {import('@datadog/pprof').CapturedProfile} CapturedProfile
 * @typedef {import('perf_hooks').PerformanceEntry} PerformanceEntry
 */

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {SampleLabel}
 */
function stringLabel (key, value) {
  return [key, safeToString(value)]
}

// We don't want to invoke toString for objects and functions, rather we'll
// provide dummy values. These values are not meant to emulate built-in toString
// behavior.
function safeToString (val) {
  switch (typeof val) {
    case 'string':
      return val
    case 'object':
      return '[object]'
    case 'function':
      return '[function]'
    default:
      return String(val)
  }
}

function getMaxSamples (flushInterval, samplingInterval) {
  const maxCpuSamples = flushInterval / samplingInterval

  // The lesser of max parallelism and libuv thread pool size, plus one so we can detect
  // oversubscription on libuv thread pool, plus another one for GC.
  const factor = Math.max(1, Math.min(availableParallelism(), effectiveLibuvThreadCount)) + 2

  // Let's not go overboard with too large limit and cap it at 100k. With current defaults, the
  // value will be 65000/10.1*(4+2) = 38613.
  return Math.min(100_000, Math.floor(maxCpuSamples * factor))
}

// Decorators add the labels of an event type's samples. Labels that many samples share are cached:
// visitors don't modify labels.
class GCDecorator {
  constructor () {
    this.kindLabels = []
    this.reasonLabels = []
    this.flagObj = {}

    // Create labels for all GC performance flags and kinds of GC
    for (const [key, value] of Object.entries(constants)) {
      if (key.startsWith('NODE_PERFORMANCE_GC_FLAGS_')) {
        this.flagObj[key.slice(26).toLowerCase()] = value
      } else if (key.startsWith('NODE_PERFORMANCE_GC_')) {
        // It's a constant for a kind of GC
        const kind = key.slice(20).toLowerCase()
        this.kindLabels[value] = stringLabel('gc type', kind)
      }
    }

    // V8's young-generation collector emits GC events with kind 2, but Node.js
    // doesn't expose a matching NODE_PERFORMANCE_GC_* constant for it, so we map it
    // explicitly. The collector was renamed from Minor Mark-Compact to Minor
    // Mark-Sweep in the V8 version that shipped with Node 22. See equivalent
    // mapping in runtime_metrics.js.
    const minorMarkGCKind = 2
    if (this.kindLabels[minorMarkGCKind] === undefined) {
      const { NODE_MAJOR } = require('../../../../../version')
      const minorGCLabel = NODE_MAJOR >= 22 ? 'minor_mark_sweep' : 'minor_mark_compact'
      this.kindLabels[minorMarkGCKind] = stringLabel('gc type', minorGCLabel)
    }
  }

  /**
   * @param {SampleLabel[]} labels
   * @param {PerformanceEntry & { detail: { kind: number, flags: number } }} item
   */
  decorateSample (labels, item) {
    const { kind, flags } = item.detail
    labels.push(this.getKindLabel(kind))
    const reasonLabel = this.getReasonLabel(flags)
    if (reasonLabel) {
      labels.push(reasonLabel)
    }
  }

  getKindLabel (kind) {
    let kindLabel = this.kindLabels[kind]
    if (kindLabel === undefined) {
      // Gracefully handle GC kinds we don't have a label for (e.g. a value
      // introduced by a future Node.js/V8 version).
      kindLabel = stringLabel('gc type', `unknown_${kind}`)
      this.kindLabels[kind] = kindLabel
    }
    return kindLabel
  }

  getReasonLabel (flags) {
    if (flags === 0) {
      return null
    }
    let reasonLabel = this.reasonLabels[flags]
    if (!reasonLabel) {
      let reasonStr = ''
      for (const [key, value] of Object.entries(this.flagObj)) {
        if (value & flags) {
          if (reasonStr) reasonStr += ','
          reasonStr += key
        }
      }
      reasonLabel = stringLabel('gc reason', reasonStr)
      this.reasonLabels[flags] = reasonLabel
    }
    return reasonLabel
  }
}

class DNSDecorator {
  /**
   * @param {SampleLabel[]} labels
   * @param {PerformanceEntry & { detail: Record<string, unknown> }} item
   */
  decorateSample (labels, item) {
    const op = item.name
    labels.push(stringLabel('operation', op))
    const detail = item.detail
    switch (op) {
      case 'lookup':
        labels.push(stringLabel('host', detail.hostname))
        break
      case 'lookupService':
        labels.push(stringLabel('address', detail.host), ['port', /** @type {number} */ (detail.port)])
        break
      case 'getHostByAddr':
        labels.push(stringLabel('address', detail.host))
        break
      default:
        if (op.startsWith('query')) {
          labels.push(stringLabel('host', detail.host))
        }
    }
  }
}

class NetDecorator {
  /**
   * @param {SampleLabel[]} labels
   * @param {PerformanceEntry & { detail: Record<string, unknown> }} item
   */
  decorateSample (labels, item) {
    const op = item.name
    labels.push(stringLabel('operation', op))
    if (op === 'connect') {
      const detail = item.detail
      labels.push(stringLabel('host', detail.host), ['port', /** @type {number} */ (detail.port)])
    }
  }
}

class KeyValueDecorator {
  /**
   * @param {SampleLabel[]} labels
   * @param {PerformanceEntry & { detail: Record<string, unknown> }} item
   */
  decorateSample (labels, item) {
    for (const [key, value] of Object.entries(item.detail)) {
      if (typeof value === 'string' || typeof value === 'number') {
        labels.push([key, value])
      }
    }
  }
}

class ZlibDecorator {
  /**
   * @param {SampleLabel[]} labels
   * @param {PerformanceEntry & { detail: Record<string, unknown> }} item
   */
  decorateSample (labels, item) {
    labels.push(stringLabel('operation', item.detail.operation))
  }
}

// Keys correspond to PerformanceEntry.entryType, values are constructor
// functions for type-specific decorators.
const decoratorTypes = {
  crypto: KeyValueDecorator,
  fs: KeyValueDecorator,
  dns: DNSDecorator,
  gc: GCDecorator,
  net: NetDecorator,
  zlib: ZlibDecorator,
}

/**
 * A timeline sample: an event's duration, end time and labels.
 *
 * @typedef {{ values: number[], timestamp: bigint, labels: SampleLabel[] }} TimelineSample
 */

// Translates performance entries into timeline samples, to be visited into a profile.
class EventSerializer {
  #sampleCount = 0

  constructor (maxSamples) {
    /** @type {TimelineSample[]} */
    this.samples = []
    this.decorators = {}
    this.maxSamples = maxSamples
  }

  addEvent (item) {
    if (this.samples.length < this.maxSamples) {
      const sample = this.#createSample(item)
      if (sample !== undefined) {
        this.samples.push(sample)
        this.#sampleCount++
      }
    } else {
      this.#sampleCount++
      // Reservoir sampling
      const replacementIndex = Math.floor(Math.random() * this.#sampleCount)
      if (replacementIndex < this.maxSamples) {
        const sample = this.#createSample(item)
        if (sample === undefined) {
          this.#sampleCount-- // unlikely
        } else {
          // This will cause the samples to no longer be sorted in their array
          // by their end time. This is fine as the backend has no ordering
          // expectations.
          this.samples[replacementIndex] = sample
        }
      }
    }
  }

  /**
   * @param {PerformanceEntry & { _ddSpanId?: bigint, _ddRootSpanId?: bigint }} item
   * @returns {TimelineSample | undefined}
   */
  #createSample (item) {
    const { entryType, startTime, duration, _ddSpanId, _ddRootSpanId } = item
    let decorator = this.decorators[entryType]
    if (!decorator) {
      const DecoratorCtor = decoratorTypes[entryType]
      if (DecoratorCtor) {
        decorator = new DecoratorCtor()
        decorator.eventTypeLabel = stringLabel('event', entryType)
        this.decorators[entryType] = decorator
      } else {
        // Shouldn't happen but it's better to not rely on observer only getting
        // requested event types.
        return
      }
    }
    const endTime = startTime + duration
    /** @type {SampleLabel[]} */
    const labels = [decorator.eventTypeLabel]
    if (_ddSpanId) {
      labels.push([SPAN_ID_LABEL, _ddSpanId])
    }
    if (_ddRootSpanId) {
      labels.push([LOCAL_ROOT_SPAN_ID_LABEL, _ddRootSpanId])
    }
    decorator.decorateSample(labels, item)
    return {
      values: [Math.round(duration * MS_TO_NS)],
      timestamp: dateOffset + BigInt(Math.round(endTime * MS_TO_NS)),
      labels,
    }
  }

  /**
   * The serializer's samples as a profile of the period, to be visited. The serializer must not
   * get more events.
   *
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {CapturedProfile}
   */
  capture (startDate, endDate) {
    const samples = this.samples
    return {
      /** @param {ProfileVisitor} visitor */
      visit (visitor) {
        visitor.metadata({
          sampleTypes: [TIMELINE_SAMPLE_TYPE],
          periodType: TIMELINE_SAMPLE_TYPE,
          period: 1,
          timeNanos: BigInt(endDate.getTime()) * BigInt(MS_TO_NS),
          durationNanos: (endDate.getTime() - startDate.getTime()) * MS_TO_NS,
        })
        const stackId = visitor.stack([visitor.frame(TIMELINE_FRAME)])
        for (const { values, timestamp, labels } of samples) {
          visitor.sample({ stackId, values, labels, timestamp })
        }
        const result = { hasMissingMapFiles: false }
        visitor.end?.(result)
        return result
      },
    }
  }
}

function add (items) {
  for (const item of items.getEntries()) {
    this.eventHandler(item)
  }
}

/**
 * Class that sources timeline events through Node.js performance measurement APIs.
 */
class NodeApiEventSource {
  constructor (eventHandler, entryTypes) {
    this.eventHandler = eventHandler
    this.observer = undefined
    this.entryTypes = entryTypes || Object.keys(decoratorTypes)
  }

  start () {
    // if already started, do nothing
    if (this.observer) return

    this.observer = new PerformanceObserver(add.bind(this))
    this.observer.observe({ entryTypes: this.entryTypes })
  }

  stop () {
    if (this.observer) {
      this.observer.disconnect()
      this.observer = undefined
    }
  }
}

class DatadogInstrumentationEventSource {
  constructor (eventHandler, eventFilter) {
    // List all entries explicitly for bundlers to pick up the require calls correctly.
    const plugins = [
      require('./event_plugins/crypto'),
      require('./event_plugins/dns_lookup'),
      require('./event_plugins/dns_lookupservice'),
      require('./event_plugins/dns_resolve'),
      require('./event_plugins/dns_reverse'),
      require('./event_plugins/fs'),
      require('./event_plugins/net'),
      require('./event_plugins/zlib'),
    ]
    this.plugins = plugins.map((Plugin) => {
      return new Plugin(eventHandler, eventFilter)
    })

    this.started = false
  }

  start () {
    if (!this.started) {
      for (const plugin of this.plugins) {
        plugin.configure({ enabled: true })
      }
      this.started = true
    }
  }

  stop () {
    if (this.started) {
      for (const plugin of this.plugins) {
        plugin.configure({ enabled: false })
      }
      this.started = false
    }
  }
}

function createPoissonProcessSamplingFilter (samplingIntervalMillis) {
  const poissonFilter = new PoissonProcessSamplingFilter({
    samplingInterval: samplingIntervalMillis,
    resetInterval: samplingIntervalMillis * POISSON_RESET_FACTOR,
    now: performance.now.bind(performance),
  })
  return poissonFilter.filter.bind(poissonFilter)
}

/**
 * This class generates profiles with timeline events. It combines an event
 * source with a sampling event filter and an event serializer.
 */
class EventsProfiler {
  #maxSamples = 0
  #timelineSamplingEnabled = false
  #eventSerializer
  #eventSources

  get type () { return 'events' }

  /**
   * @param {TracerConfig} config
   * @param {{ flushInterval: number }} runtime
   */
  constructor (config, { flushInterval }) {
    this.#maxSamples = getMaxSamples(flushInterval, SAMPLING_INTERVAL)
    this.#timelineSamplingEnabled = config.DD_INTERNAL_PROFILING_TIMELINE_SAMPLING_ENABLED
    this.#eventSerializer = new EventSerializer(this.#maxSamples)

    const eventHandler = event => this.#eventSerializer.addEvent(event)
    const eventFilter = this.#timelineSamplingEnabled
      ? createPoissonProcessSamplingFilter(SAMPLING_INTERVAL)
      : () => true
    const filteringEventHandler = event => {
      if (eventFilter(event)) {
        eventHandler(event)
      }
    }

    this.#eventSources = config.DD_PROFILING_CODEHOTSPOTS_ENABLED
      // Use Datadog instrumentation to collect events with span IDs. Still use
      // Node API for GC events.
      ? [
          new DatadogInstrumentationEventSource(eventHandler, eventFilter),
          new NodeApiEventSource(filteringEventHandler, ['gc']),
        ]
      // Use Node API instrumentation to collect events without span IDs
      : [
          new NodeApiEventSource(filteringEventHandler),
        ]
  }

  start () {
    for (const source of this.#eventSources) {
      source.start()
    }
  }

  stop () {
    for (const source of this.#eventSources) {
      source.stop()
    }
  }

  /**
   * @param {boolean} restart
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {CapturedProfile}
   */
  profile (restart, startDate, endDate) {
    if (!restart) {
      this.stop()
    }
    const thatEventSerializer = this.#eventSerializer
    this.#eventSerializer = new EventSerializer(this.#maxSamples)
    return thatEventSerializer.capture(startDate, endDate)
  }

  /**
   * How pprof profiles of the captured profiles are built: samples' times are end_timestamp_ns labels.
   *
   * @returns {import('@datadog/pprof').PprofSerializerOptions}
   */
  get pprofBuilderOptions () {
    return { timestampLabel: END_TIMESTAMP_LABEL }
  }

  getInfo () {
    return {
      maxSamples: this.#maxSamples,
    }
  }

  /**
   * @param {CapturedProfile} profile
   */
  encode (profile) {
    const { PprofProfileBuilder } = require('@datadog/pprof')
    const builder = new PprofProfileBuilder(this.pprofBuilderOptions)
    profile.visit(builder.visitor())
    return encodeProfileAsync(builder.build())
  }
}

module.exports = EventsProfiler
