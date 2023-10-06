'use strict'

const asyncHooks = require('async_hooks')
const { performance } = require('node:perf_hooks')
const { storage } = require('../../../../datadog-core')
const { Function, Label, Line, Location, Profile, Sample, StringTable, ValueType } = require('pprof-format')
const pprof = require('@datadog/pprof/')
const { END_TIMESTAMP, ROOT_SPAN_ID, SPAN_ID } = require('./shared')

const MS_TO_NS = 1000000

function getActiveSpan () {
  const store = storage.getStore()
  return store && store.span
}

function endOfQuantum (t, q) {
  return (Math.floor(t / q) + 1) * q
}

class Timeline {
  constructor (options = {}) {
    this.type = 'timeline'
    this._samplingIntervalMillis = Math.floor(options.samplingInterval / 1e6 || 1e3 / 99) // 99hz
    this._flushIntervalNanos = (options.flushInterval || 60000) * 1e6 // 60 sec
    // The structure of this._accumulators object is as follows: top-level
    // property names are span IDs in decimal string encoding. Empty string is
    // used as the property name for execution context not associated with a
    // span. Every such span property value is itself an object, with properties
    // "rootSpanId" for local root span ID (when identifiable), and "ref" for a
    // reference count. It will have further properties named after the event
    // type. The value of these properties is an array of objects representing
    // the quanta, with "end" property as hrtime bigint of the quantum end, and
    // "duration" as the duration in nanoseconds (a number). So something like:
    /*
    { "": { "ref": 4,
            "TCPWRAP": [{ "end": 5635.496890, "duration": 175000},
                        { "end": 5645.597850, "duration": 1154541},...],
            "HTTPCLIENTREQUEST": [{ "end": 5635.496890, "duration": 84416},
                                  { "end": 5645.597850, "duration": 494125}, ...]
      },
      "8902676252807731318": { "rootSpanId": "6976680365829768426", "ref": 1,
            "FSREQCALLBACK": [{ "end": 8231.456460, "duration": 1220918},
                              { "end": 8241.557470, "duration": 774915}, ...],
            "ZLIB": [{ "end": 8342.567570n, "duration": 397250},
                     { "end": 8352.668580n, "duration": 237210}, ...]
      },
      ...
    }
    */
    // A single span might be referenced from multiple active async tasks, that's
    // what we track with "ref". A span whose ref is 0 and that has no recorded
    // durations of any event type will be removed during a profile() call.

    this._accumulators = new Map()
    this._active = new Map()
  }

  start () {
    if (!this._hook) {
      this._hook = asyncHooks.createHook({
        init: this._init.bind(this),
        before: this._before.bind(this),
        after: this._after.bind(this),
        destroy: this._destroy.bind(this)
      })
    }
    this._hook.enable()
  }

  stop () {
    const profile = this.profile()
    if (this._hook) {
      this._hook.disable()
    }
    return profile
  }

  profile () {
    const hrNow = this._hrnow()
    return this._createProfileFromReport(this._reportUntil(hrNow), performance.timeOrigin, hrNow)
  }

  encode (profile) {
    return pprof.encode(profile)
  }

  _init (asyncId, type) {
    if (type !== 'TickObject' && type !== 'Timeout') {
      const span = getActiveSpan()
      const ctx = span?.context()
      const spanId = ctx?.toSpanId()
      const activity = this._createActivity(type, spanId, ctx)
      this._active.set(asyncId, activity)
    }
  }

  _before (asyncId) {
    const activity = this._active.get(asyncId)
    if (activity) {
      this._startActivity(activity, this._hrnow())
    }
  }

  // time parameter is only explicitly passed for testing
  _after (asyncId) {
    const activity = this._active.get(asyncId)
    if (activity) {
      this._stopActivity(activity, this._hrnow())
    }
  }

  _destroy (asyncId) {
    const activity = this._active.get(asyncId)
    if (activity) {
      --activity.spanData.ref
    }
  }

  _hrnow() {
    // We could've used process.hrtime.bigint() but it's a bigint so it'll need
    // more storage. performance.now() returns millis since process start as an
    // ordinary 64-bit IEEE double precision floating point number. It encodes
    // nanos in its fractional part. 1e9 nanos needs about 30 bits, and a FP
    // double has a 53 bit mantissa, so it'll retain 1ns resolution for about
    // 2^23 seconds, or 97 days, after which it'll lose one bit of precision,
    // and this one bit precision loss will happens every 97 days. Monotonic
    // CPU performance counters on most architectures don't provide better than
    // 30ns or so resolution (measured 41ns on Apple M1 Max) so a process can
    // stay up for 5x97 days, or about 16 months before this number's resolution
    // drops to 2^5=32ns, close to the actual timer's resolution. This seems
    // like an acceptable upper limit on process uptime.
    return performance.now()
  }

  _createActivity (type, spanId, ctx) {
    const spanKey = spanId ?? ''
    let spanData = this._accumulators.get(spanKey)
    let quanta
    if (!spanData) {
      quanta = []
      spanData = new Map()
      spanData.rootSpanId = ctx?._trace.started[0]?.context().toSpanId(),
      spanData.ref = 1
      spanData.set(type, quanta)
      this._accumulators.set(spanKey, spanData)
    } else {
      spanData.ref++
      quanta = spanData.get(type)
      if (!quanta) {
        quanta = []
        spanData.set(type, quanta)
      }
    }
    return { spanData, quanta, start: Infinity }
  }

  _startActivity(activity, time) {
    activity.start = time
  }

  _stopActivity(activity, time) {
    this._addDuration(activity.quanta, activity.start, time)
    activity.start = Infinity
  }

  _addDuration (quanta, start, end) {
    // Chop up the duration of this (after-before) activation into quanta at
    // 10ms boundaries; add these quantized durations to the sum quantums,
    // creating new ones as needed.
    while (start < end) {
      // end ns of the current quantum
      const quantumEnd = endOfQuantum(start, this._samplingIntervalMillis)
      // end ns of the activation
      const endInQuantum = end < quantumEnd ? end : quantumEnd
      // Duration should always fit in a JS number; 2^53 is good for 104 days
      // worth of nanoseconds
      const duration = Number(endInQuantum - start)
      // Most likely quantum is the last one in the quanta array (the most
      // recent), so we work from it backwards until we either...
      let i = quanta.length - 1
      for (; i >= 0; --i) {
        const quantum = quanta[i]
        if (quantum.end === quantumEnd) {
          // ... find the right quantum for this partial duration, or...
          quantum.duration += duration
          break
        } else if (quantum.end < quantumEnd) {
          // ... an insertion point for a new one.
          quanta.splice(i + 1, 0, { end: quantumEnd, duration: duration })
          break
        }
      }
      if (i === -1) {
        // ... special case for insertion point being at the front of the array
        quanta.splice(0, 0, { end: quantumEnd, duration: duration })
      }
      // advance start to the next quantum
      start = quantumEnd
    }
  }

  // All duration quanta reportable in a profile, meaning those that happened
  // until the specified time. Written as a generator to separate the logic of
  // selecting the data to report from the actual building of profile objects.
  // The reported information is removed from _accumulators. All remaining
  // information's timestamps are rebased on time.
  * _reportUntil (time) {
    const currQuantumEnd = endOfQuantum(time, this._samplingIntervalMillis)
    const currQuantumStart = currQuantumEnd - this._samplingIntervalMillis

    // Add partial duration of currently running activities that started
    // before the current time quantum into their previous time quantum
    // durations. Note that since Node.JS is single-threaded, this'll only apply
    // to real async activities (e.g. ZLIB, crypto operations.)
    for(const activity of this._active.values()) {
      if (activity.start < currQuantumStart) {
        this._addDuration(activity.quanta, activity.start, currQuantumStart)
        // Since we reported the activity duration up to currQuantumStart,
        // we need to adjust its start to currQuantumStart.
        activity.start = currQuantumStart
      }
    }

    for (const [spanKey, spanData] of this._accumulators) {
      let hasEntries = false
      const { rootSpanId } = spanData
      const spanId = spanKey !== '' ? spanKey : undefined
      for (const [type, quanta] of spanData) {
        let i = quanta.length - 1
        for (; i >= 0; --i) {
          if (quanta[i].end < currQuantumEnd) break
        }
        if (i >= 0) {
          yield { type, spanId, rootSpanId, quanta: quanta.splice(0, i + 1) }
        }
        if (!hasEntries && quanta.length) {
          hasEntries = true
        }
      }
      if (!hasEntries && spanData.ref === 0 && spanKey !== '') {
        // Delete empty spans
        this._accumulators.delete(spanKey)
      }
    }
  }

  // Takes a generator from _reportUntil and creates a pprof Profile from it.
  // Additionally takes the time origin for the high-resolution time, and a
  // current high-resolution time.
  _createProfileFromReport (accs, timeOrigin, hrNow) {
    const stringTable = new StringTable()
    const timestampLabelKey = stringTable.dedup(END_TIMESTAMP)
    const spanLabelKey = stringTable.dedup(SPAN_ID)
    const rootSpanLabelKey = stringTable.dedup(ROOT_SPAN_ID)
    const typeLabelKey = stringTable.dedup('async_resource_type')

    const samples = []
    const locations = []
    const locationsPerType = {}
    const functions = []

    const spanLabels = {}
    const typeLabels = {}

    function makeLabel (key, str, labels) {
      if (str) {
        let label = labels[str]
        if (!label) {
          label = new Label({ key, str: stringTable.dedup(str) })
          labels[str] = label
        }
        return label
      }
    }

    let durationFrom = hrNow + this._samplingIntervalNanos
    let durationTo = 0

    const dateOffset = BigInt(timeOrigin * MS_TO_NS)

    for (;;) {
      const next = accs.next()
      if (next.done) break

      const { type, spanId, rootSpanId, quanta } = next.value
      let location = locationsPerType[type]
      if (!location) {
        const fn = new Function({ id: functions.length + 1, name: stringTable.dedup(type) })
        functions.push(fn)
        const line = new Line({ functionId: fn.id })
        location = new Location({ id: locations.length + 1, line: [line] })
        locations.push(location)
        locationsPerType[type] = location
      }
      const spanLabel = makeLabel(spanLabelKey, spanId, spanLabels)
      const rootSpanLabel = makeLabel(rootSpanLabelKey, rootSpanId, spanLabels)
      const typeLabel = makeLabel(typeLabelKey, type, typeLabels)

      for (const q of quanta) {
        const end = q.end
        const start = end - this._samplingIntervalMillis
        if (end > durationTo) durationTo = end
        if (start < durationFrom) durationFrom = start
        const labels = [new Label({ key: timestampLabelKey, num: BigInt(q.end * MS_TO_NS) + dateOffset }), typeLabel]
        if (spanLabel) labels.push(spanLabel)
        if (rootSpanLabel) labels.push(rootSpanLabel)
        samples.push(new Sample({
          locationId: [location.id],
          value: [q.duration * MS_TO_NS],
          label: labels
        }))
      }
    }

    const timeValueType = new ValueType({
      type: stringTable.dedup('timeline'),
      unit: stringTable.dedup('nanoseconds')
    })

    return new Profile({
      sampleType: [timeValueType],
      timeNanos: dateNow,
      periodType: timeValueType,
      period: this._flushIntervalNanos,
      durationNanos: Math.max(0, Number(durationTo - durationFrom)),
      sample: samples,
      location: locations,
      function: functions,
      stringTable: stringTable
    })
  }
}

module.exports = Timeline
