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
const threadName = `${threadNamePrefix} GC`

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
    // Currently only support GC
    this._observer.observe({ entryTypes: ['gc'] })
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
    const timestampLabelKey = stringTable.dedup(END_TIMESTAMP)
    const kindLabelKey = stringTable.dedup('gc type')
    const reasonLabelKey = stringTable.dedup('gc reason')
    const kindLabels = []
    const reasonLabels = []
    const locations = []
    const functions = []
    const locationsPerKind = []
    const flagObj = {}

    function labelFromStr (key, valStr) {
      return new Label({ key, str: stringTable.dedup(valStr) })
    }

    function labelFromStrStr (keyStr, valStr) {
      return labelFromStr(stringTable.dedup(keyStr), valStr)
    }

    // Create labels for all GC performance flags and kinds of GC
    for (const [key, value] of Object.entries(constants)) {
      if (key.startsWith('NODE_PERFORMANCE_GC_FLAGS_')) {
        flagObj[key.substring(26).toLowerCase()] = value
      } else if (key.startsWith('NODE_PERFORMANCE_GC_')) {
        // It's a constant for a kind of GC
        const kind = key.substring(20).toLowerCase()
        kindLabels[value] = labelFromStr(kindLabelKey, kind)
        // Construct a single-frame "location" too
        const fn = new Function({ id: functions.length + 1, name: stringTable.dedup(`${kind} GC`) })
        functions.push(fn)
        const line = new Line({ functionId: fn.id })
        const location = new Location({ id: locations.length + 1, line: [line] })
        locations.push(location)
        locationsPerKind[value] = [location.id]
      }
    }

    const gcEventLabel = labelFromStrStr('event', 'gc')
    const threadLabel = labelFromStrStr(THREAD_NAME, threadName)

    function getReasonLabel (flags) {
      if (flags === 0) {
        return null
      }
      let reasonLabel = reasonLabels[flags]
      if (!reasonLabel) {
        const reasons = []
        for (const [key, value] of Object.entries(flagObj)) {
          if (value & flags) {
            reasons.push(key)
          }
        }
        const reasonStr = reasons.join(',')
        reasonLabel = labelFromStr(reasonLabelKey, reasonStr)
        reasonLabels[flags] = reasonLabel
      }
      return reasonLabel
    }

    let durationFrom = Number.POSITIVE_INFINITY
    let durationTo = 0
    const dateOffset = BigInt(Math.round(performance.timeOrigin * MS_TO_NS))

    const samples = this.entries.map((item) => {
      const { startTime, duration } = item
      const { kind, flags } = node16 ? item.detail : item
      const endTime = startTime + duration
      if (durationFrom > startTime) durationFrom = startTime
      if (durationTo < endTime) durationTo = endTime
      const labels = [
        gcEventLabel,
        threadLabel,
        new Label({ key: timestampLabelKey, num: dateOffset + BigInt(Math.round(endTime * MS_TO_NS)) }),
        kindLabels[kind]
      ]
      const reasonLabel = getReasonLabel(flags)
      if (reasonLabel) {
        labels.push(reasonLabel)
      }
      const sample = new Sample({
        value: [Math.round(duration * MS_TO_NS)],
        label: labels,
        locationId: locationsPerKind[kind]
      })
      return sample
    })

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
