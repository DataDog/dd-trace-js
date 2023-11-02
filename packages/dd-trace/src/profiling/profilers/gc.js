const { performance, constants, PerformanceObserver } = require('node:perf_hooks')
const { END_TIMESTAMP } = require('./shared')
const semver = require('semver')
const { Function, Label, Line, Location, Profile, Sample, StringTable, ValueType } = require('pprof-format')
const pprof = require('@datadog/pprof/')

const node16 = semver.gte(process.version, '16.0.0')
const MS_TO_NS = 1000000

function bigintReplacer (key, value) {
  if (typeof value === 'bigint') {
    return value.toString()
  } else {
    return value
  }
}

class GarbageCollection {
  constructor (options = {}) {
    this.type = 'gc'
    this._flushIntervalNanos = (options.flushInterval || 60000) * 1e6 // 60 sec
    this._observer = undefined
    this.entries = []
  }

  start () {
    if (!this._observer) {
      function add (items) {
        this.entries.push(...items.getEntries())
      }
      this._observer = new PerformanceObserver(add.bind(this))
    }
    this._observer.observe({ type: 'gc' })
  }

  stop () {
    if (this._observer) {
      this._observer.disconnect()
    }
  }

  profile () {
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

    for (const [key, value] of Object.entries(constants)) {
      if (key.startsWith('NODE_PERFORMANCE_GC_FLAGS_')) {
        flagObj[key.substring(26).toLowerCase()] = value
      } else if (key.startsWith('NODE_PERFORMANCE_GC_')) {
        // It's a constant for a kind of GC
        const kind = key.substring(20).toLowerCase()
        kindLabels[value] = new Label({ key: kindLabelKey, str: stringTable.dedup(kind) })
        // Construct a single-frame "location" too
        const fn = new Function({ id: functions.length + 1, name: stringTable.dedup(`${kind} GC`) })
        functions.push(fn)
        const line = new Line({ functionId: fn.id })
        const location = new Location({ id: locations.length + 1, line: [line] })
        locations.push(location)
        locationsPerKind[value] = [location.id]
      }
    }

    const gcEventLabel = new Label({ key: stringTable.dedup('event'), str: stringTable.dedup('gc') })
    const dateOffset = BigInt(Math.round(performance.timeOrigin * MS_TO_NS))

    let durationFrom = Number.POSITIVE_INFINITY
    let durationTo = 0

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
        reasonLabel = new Label({ key: reasonLabelKey, str: stringTable.dedup(reasonStr) })
        reasonLabels[flags] = reasonLabel
      }
      return reasonLabel
    }

    const samples = this.entries.map((item) => {
      const { startTime, duration } = item
      const { kind, flags } = node16 ? item.detail : item
      const endTime = startTime + duration
      if (durationFrom > startTime) durationFrom = startTime
      if (durationTo < endTime) durationTo = endTime
      const labels = [
        gcEventLabel,
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
      type: stringTable.dedup('timeline'),
      unit: stringTable.dedup('nanoseconds')
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

module.exports = GarbageCollection
