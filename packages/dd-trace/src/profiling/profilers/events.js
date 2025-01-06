const { performance, constants, PerformanceObserver } = require('perf_hooks')
const { END_TIMESTAMP_LABEL, SPAN_ID_LABEL, LOCAL_ROOT_SPAN_ID_LABEL } = require('./shared')
const { Function, Label, Line, Location, Profile, Sample, StringTable, ValueType } = require('pprof-format')
const pprof = require('@datadog/pprof/')

// perf_hooks uses millis, with fractional part representing nanos. We emit nanos into the pprof file.
const MS_TO_NS = 1000000

// While this is an "events profiler", meaning it emits a pprof file based on events observed as
// perf_hooks events, the emitted pprof file uses the type "timeline".
const pprofValueType = 'timeline'
const pprofValueUnit = 'nanoseconds'

const dateOffset = BigInt(Math.round(performance.timeOrigin * MS_TO_NS))

function labelFromStr (stringTable, key, valStr) {
  return new Label({ key, str: stringTable.dedup(safeToString(valStr)) })
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

function labelFromStrStr (stringTable, keyStr, valStr) {
  return labelFromStr(stringTable, stringTable.dedup(keyStr), valStr)
}

class GCDecorator {
  constructor (stringTable) {
    this.stringTable = stringTable
    this.reasonLabelKey = stringTable.dedup('gc reason')
    this.kindLabels = []
    this.reasonLabels = []
    this.flagObj = {}

    const kindLabelKey = stringTable.dedup('gc type')

    // Create labels for all GC performance flags and kinds of GC
    for (const [key, value] of Object.entries(constants)) {
      if (key.startsWith('NODE_PERFORMANCE_GC_FLAGS_')) {
        this.flagObj[key.substring(26).toLowerCase()] = value
      } else if (key.startsWith('NODE_PERFORMANCE_GC_')) {
        // It's a constant for a kind of GC
        const kind = key.substring(20).toLowerCase()
        this.kindLabels[value] = labelFromStr(stringTable, kindLabelKey, kind)
      }
    }
  }

  decorateSample (sampleInput, item) {
    const { kind, flags } = item.detail
    sampleInput.label.push(this.kindLabels[kind])
    const reasonLabel = this.getReasonLabel(flags)
    if (reasonLabel) {
      sampleInput.label.push(reasonLabel)
    }
  }

  getReasonLabel (flags) {
    if (flags === 0) {
      return null
    }
    let reasonLabel = this.reasonLabels[flags]
    if (!reasonLabel) {
      const reasons = []
      for (const [key, value] of Object.entries(this.flagObj)) {
        if (value & flags) {
          reasons.push(key)
        }
      }
      const reasonStr = reasons.join(',')
      reasonLabel = labelFromStr(this.stringTable, this.reasonLabelKey, reasonStr)
      this.reasonLabels[flags] = reasonLabel
    }
    return reasonLabel
  }
}

class DNSDecorator {
  constructor (stringTable) {
    this.stringTable = stringTable
    this.operationNameLabelKey = stringTable.dedup('operation')
    this.hostLabelKey = stringTable.dedup('host')
    this.addressLabelKey = stringTable.dedup('address')
    this.portLabelKey = stringTable.dedup('port')
  }

  decorateSample (sampleInput, item) {
    const labels = sampleInput.label
    const stringTable = this.stringTable
    function addLabel (labelNameKey, labelValue) {
      labels.push(labelFromStr(stringTable, labelNameKey, labelValue))
    }
    const op = item.name
    addLabel(this.operationNameLabelKey, item.name)
    const detail = item.detail
    switch (op) {
      case 'lookup':
        addLabel(this.hostLabelKey, detail.hostname)
        break
      case 'lookupService':
        addLabel(this.addressLabelKey, detail.host)
        labels.push(new Label({ key: this.portLabelKey, num: detail.port }))
        break
      case 'getHostByAddr':
        addLabel(this.addressLabelKey, detail.host)
        break
      default:
        if (op.startsWith('query')) {
          addLabel(this.hostLabelKey, detail.host)
        }
    }
  }
}

class NetDecorator {
  constructor (stringTable) {
    this.stringTable = stringTable
    this.operationNameLabelKey = stringTable.dedup('operation')
    this.hostLabelKey = stringTable.dedup('host')
    this.portLabelKey = stringTable.dedup('port')
  }

  decorateSample (sampleInput, item) {
    const labels = sampleInput.label
    const stringTable = this.stringTable
    function addLabel (labelNameKey, labelValue) {
      labels.push(labelFromStr(stringTable, labelNameKey, labelValue))
    }
    const op = item.name
    addLabel(this.operationNameLabelKey, op)
    if (op === 'connect') {
      const detail = item.detail
      addLabel(this.hostLabelKey, detail.host)
      labels.push(new Label({ key: this.portLabelKey, num: detail.port }))
    }
  }
}

class FilesystemDecorator {
  constructor (stringTable) {
    this.stringTable = stringTable
  }

  decorateSample (sampleInput, item) {
    const labels = sampleInput.label
    const stringTable = this.stringTable
    Object.entries(item.detail).forEach(([k, v]) => {
      switch (typeof v) {
        case 'string':
          labels.push(labelFromStrStr(stringTable, k, v))
          break
        case 'number':
          labels.push(new Label({ key: stringTable.dedup(k), num: v }))
      }
    })
  }
}

// Keys correspond to PerformanceEntry.entryType, values are constructor
// functions for type-specific decorators.
const decoratorTypes = {
  fs: FilesystemDecorator,
  dns: DNSDecorator,
  gc: GCDecorator,
  net: NetDecorator
}

// Translates performance entries into pprof samples.
class EventSerializer {
  constructor () {
    this.stringTable = new StringTable()
    this.samples = []
    this.locations = []
    this.functions = []
    this.decorators = {}

    // A synthetic single-frame location to serve as the location for timeline
    // samples. We need these as the profiling backend (mimicking official pprof
    // tool's behavior) ignores these.
    const fn = new Function({ id: this.functions.length + 1, name: this.stringTable.dedup('') })
    this.functions.push(fn)
    const line = new Line({ functionId: fn.id })
    const location = new Location({ id: this.locations.length + 1, line: [line] })
    this.locations.push(location)
    this.locationId = [location.id]

    this.timestampLabelKey = this.stringTable.dedup(END_TIMESTAMP_LABEL)
    this.spanIdKey = this.stringTable.dedup(SPAN_ID_LABEL)
    this.rootSpanIdKey = this.stringTable.dedup(LOCAL_ROOT_SPAN_ID_LABEL)
  }

  addEvent (item) {
    const { entryType, startTime, duration, _ddSpanId, _ddRootSpanId } = item
    let decorator = this.decorators[entryType]
    if (!decorator) {
      const DecoratorCtor = decoratorTypes[entryType]
      if (DecoratorCtor) {
        decorator = new DecoratorCtor(this.stringTable)
        decorator.eventTypeLabel = labelFromStrStr(this.stringTable, 'event', entryType)
        this.decorators[entryType] = decorator
      } else {
        // Shouldn't happen but it's better to not rely on observer only getting
        // requested event types.
        return
      }
    }
    const endTime = startTime + duration
    const label = [
      decorator.eventTypeLabel,
      new Label({ key: this.timestampLabelKey, num: dateOffset + BigInt(Math.round(endTime * MS_TO_NS)) })
    ]
    if (_ddSpanId) {
      label.push(labelFromStr(this.stringTable, this.spanIdKey, _ddSpanId))
    }
    if (_ddRootSpanId) {
      label.push(labelFromStr(this.stringTable, this.rootSpanIdKey, _ddRootSpanId))
    }

    const sampleInput = {
      value: [Math.round(duration * MS_TO_NS)],
      locationId: this.locationId,
      label
    }
    decorator.decorateSample(sampleInput, item)
    this.samples.push(new Sample(sampleInput))
  }

  createProfile (startDate, endDate) {
    const timeValueType = new ValueType({
      type: this.stringTable.dedup(pprofValueType),
      unit: this.stringTable.dedup(pprofValueUnit)
    })

    return new Profile({
      sampleType: [timeValueType],
      timeNanos: endDate.getTime() * MS_TO_NS,
      periodType: timeValueType,
      period: 1,
      durationNanos: (endDate.getTime() - startDate.getTime()) * MS_TO_NS,
      sample: this.samples,
      location: this.locations,
      function: this.functions,
      stringTable: this.stringTable
    })
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

    function add (items) {
      for (const item of items.getEntries()) {
        this.eventHandler(item)
      }
    }

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
    this.plugins = ['dns_lookup', 'dns_lookupservice', 'dns_resolve', 'dns_reverse', 'fs', 'net'].map(m => {
      const Plugin = require(`./event_plugins/${m}`)
      return new Plugin(eventHandler, eventFilter)
    })

    this.started = false
  }

  start () {
    if (!this.started) {
      this.plugins.forEach(p => p.configure({ enabled: true }))
      this.started = true
    }
  }

  stop () {
    if (this.started) {
      this.plugins.forEach(p => p.configure({ enabled: false }))
      this.started = false
    }
  }
}

class CompositeEventSource {
  constructor (sources) {
    this.sources = sources
  }

  start () {
    this.sources.forEach(s => s.start())
  }

  stop () {
    this.sources.forEach(s => s.stop())
  }
}

function createPossionProcessSamplingFilter (samplingIntervalMillis) {
  let nextSamplingInstant = performance.now()
  let currentSamplingInstant = 0
  setNextSamplingInstant()

  return event => {
    const endTime = event.startTime + event.duration
    while (endTime >= nextSamplingInstant) {
      setNextSamplingInstant()
    }
    // An event is sampled if it started before, and ended on or after a sampling instant. The above
    // while loop will ensure that the ending invariant is always true for the current sampling
    // instant so we don't have to test for it below. Across calls, the invariant also holds as long
    // as the events arrive in endTime order. This is true for events coming from
    // DatadogInstrumentationEventSource; they will be ordered by endTime by virtue of this method
    // being invoked synchronously with the plugins' finish() handler which evaluates
    // performance.now(). OTOH, events coming from NodeAPIEventSource (GC in typical setup) might be
    // somewhat delayed as they are queued by Node, so they can arrive out of order with regard to
    // events coming from the non-queued source. By omitting the endTime check, we will pass through
    // some short events that started and ended before the current sampling instant. OTOH, if we
    // were to check for this.currentSamplingInstant <= endTime, we would discard some long events
    // that also ended before the current sampling instant. We'd rather err on the side of including
    // some short events than excluding some long events.
    return event.startTime < currentSamplingInstant
  }

  function setNextSamplingInstant () {
    currentSamplingInstant = nextSamplingInstant
    nextSamplingInstant -= Math.log(1 - Math.random()) * samplingIntervalMillis
  }
}

/**
 * This class generates pprof files with timeline events. It combines an event
 * source with a sampling event filter and an event serializer.
 */
class EventsProfiler {
  constructor (options = {}) {
    this.type = 'events'
    this.eventSerializer = new EventSerializer()

    const eventHandler = event => this.eventSerializer.addEvent(event)
    const eventFilter = options.timelineSamplingEnabled
      // options.samplingInterval comes in microseconds, we need millis
      ? createPossionProcessSamplingFilter((options.samplingInterval ?? 1e6 / 99) / 1000)
      : _ => true
    const filteringEventHandler = event => {
      if (eventFilter(event)) {
        eventHandler(event)
      }
    }

    if (options.codeHotspotsEnabled) {
      // Use Datadog instrumentation to collect events with span IDs. Still use
      // Node API for GC events.
      this.eventSource = new CompositeEventSource([
        new DatadogInstrumentationEventSource(eventHandler, eventFilter),
        new NodeApiEventSource(filteringEventHandler, ['gc'])
      ])
    } else {
      // Use Node API instrumentation to collect events without span IDs
      this.eventSource = new NodeApiEventSource(filteringEventHandler)
    }
  }

  start () {
    this.eventSource.start()
  }

  stop () {
    this.eventSource.stop()
  }

  profile (restart, startDate, endDate) {
    if (!restart) {
      this.stop()
    }
    const thatEventSerializer = this.eventSerializer
    this.eventSerializer = new EventSerializer()
    return () => thatEventSerializer.createProfile(startDate, endDate)
  }

  encode (profile) {
    return pprof.encode(profile())
  }
}

module.exports = EventsProfiler
