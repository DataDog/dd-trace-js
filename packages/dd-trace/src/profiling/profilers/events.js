const { performance, constants, PerformanceObserver } = require('node:perf_hooks')
const { END_TIMESTAMP, THREAD_NAME, threadNamePrefix } = require('./shared')
const semver = require('semver')
const { Function, Label, Line, Location, Profile, Sample, StringTable, ValueType } = require('pprof-format')
const pprof = require('@datadog/pprof/')

// Format of perf_hooks events changed with Node 16, we need to be mindful of it.
const node16 = semver.gte(process.version, '16.0.0')

// perf_hooks uses millis, with fractional part representing nanos. We emit nanos into the pprof file.
const MS_TO_NS = 1000000

// While this is an "events profiler", meaning it emits a pprof file based on events observed as
// perf_hooks events, the emitted pprof file uses the type "timeline".
const pprofValueType = 'timeline'
const pprofValueUnit = 'nanoseconds'

function labelFromStr (stringTable, key, valStr) {
  return new Label({ key, str: stringTable.dedup(valStr) })
}

function labelFromStrStr (stringTable, keyStr, valStr) {
  return labelFromStr(stringTable, stringTable.dedup(keyStr), valStr)
}

class GCDecorator {
  constructor (stringTable, locations, functions) {
    this.stringTable = stringTable
    this.reasonLabelKey = stringTable.dedup('gc reason')
    this.kindLabels = []
    this.reasonLabels = []
    this.locationsPerKind = []
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
        // Construct a single-frame "location" too
        const fn = new Function({ id: functions.length + 1, name: stringTable.dedup(`${kind} GC`) })
        functions.push(fn)
        const line = new Line({ functionId: fn.id })
        const location = new Location({ id: locations.length + 1, line: [line] })
        locations.push(location)
        this.locationsPerKind[value] = [location.id]
      }
    }
  }

  decorateSample (sampleInput, item) {
    const { kind, flags } = node16 ? item.detail : item
    sampleInput.label.push(this.kindLabels[kind])
    const reasonLabel = this.getReasonLabel(flags)
    if (reasonLabel) {
      sampleInput.label.push(reasonLabel)
    }
    sampleInput.locationId = this.locationsPerKind[kind]
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
        addLabel(this.addressLabelKey, `${detail.host}:${detail.port}`)
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

// Keys correspond to PerformanceEntry.entryType, values are constructor
// functions for type-specific decorators.
const decoratorTypes = {
  gc: GCDecorator
}
const threadNames = {
  gc: 'GC'
}
// Needs at least node 16 for DNS
if (node16) {
  decoratorTypes.dns = DNSDecorator
  threadNames.dns = 'DNS'
}

/**
 * This class generates pprof files with timeline events sourced from Node.js
 * performance measurement APIs.
 */
class EventsProfiler {
  constructor (options = {}) {
    this.type = 'events'
    this._flushIntervalNanos = (options.flushInterval || 60000) * 1e6 // 60 sec
    this._observer = undefined
    this.entries = []
  }

  start () {
    function add (items) {
      this.entries.push(...items.getEntries())
    }
    if (!this._observer) {
      this._observer = new PerformanceObserver(add.bind(this))
    }
    this._observer.observe({ entryTypes: Object.keys(decoratorTypes) })
  }

  stop () {
    if (this._observer) {
      this._observer.disconnect()
    }
  }

  profile () {
    if (this.entries.length === 0) {
      // No events in the period; don't produce a profile
      return null
    }

    const stringTable = new StringTable()
    const locations = []
    const functions = []
    const decorators = {}
    for (const [eventType, DecoratorCtor] of Object.entries(decoratorTypes)) {
      const decorator = new DecoratorCtor(stringTable, locations, functions)
      decorator.eventTypeLabel = labelFromStrStr(stringTable, 'event', eventType)
      decorator.threadNameLabel = labelFromStrStr(stringTable, THREAD_NAME,
        `${threadNamePrefix} ${threadNames[eventType]}`)
      decorators[eventType] = decorator
    }
    const timestampLabelKey = stringTable.dedup(END_TIMESTAMP)

    let durationFrom = Number.POSITIVE_INFINITY
    let durationTo = 0
    const dateOffset = BigInt(Math.round(performance.timeOrigin * MS_TO_NS))

    const samples = this.entries.map((item) => {
      const decorator = decorators[item.entryType]
      if (!decorator) {
        // Shouldn't happen but it's better to not rely on observer only getting
        // requested event types.
        return null
      }
      const { startTime, duration } = item
      const endTime = startTime + duration
      if (durationFrom > startTime) durationFrom = startTime
      if (durationTo < endTime) durationTo = endTime
      const sampleInput = {
        value: [Math.round(duration * MS_TO_NS)],
        label: [
          decorator.eventTypeLabel,
          decorator.threadNameLabel,
          new Label({ key: timestampLabelKey, num: dateOffset + BigInt(Math.round(endTime * MS_TO_NS)) })
        ]
      }
      decorator.decorateSample(sampleInput, item)
      return new Sample(sampleInput)
    }).filter(v => v)

    this.entries = []

    const timeValueType = new ValueType({
      type: stringTable.dedup(pprofValueType),
      unit: stringTable.dedup(pprofValueUnit)
    })

    return new Profile({
      sampleType: [timeValueType],
      timeNanos: dateOffset + BigInt(Math.round(durationFrom * MS_TO_NS)),
      periodType: timeValueType,
      period: this._flushIntervalNanos,
      durationNanos: Math.max(0, Math.round((durationTo - durationFrom) * MS_TO_NS)),
      sample: samples,
      location: locations,
      function: functions,
      stringTable: stringTable
    })
  }

  encode (profile) {
    return pprof.encode(profile)
  }
}

module.exports = EventsProfiler
