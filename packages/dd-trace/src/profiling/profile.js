'use strict'

const { perftools } = require('../../../../protobuf/profile')

class Profile {
  constructor (sampleType, periodType, period) {
    this._stringTable = new Map([['', 0]])
    this._locations = new Map()
    this._functions = new Map()
    this._samples = new Map()
    this._links = new Map()
    this._sampleType = this._toSampleType(sampleType)
    this._periodType = this._toValueType(periodType)
    this._period = period
    this._timeNanos = Date.now() * 1e6
    this._properties = {}
  }

  export () {
    return new perftools.profiles.Profile({
      sampleType: this._sampleType,
      periodType: this._periodType,
      sample: Array.from(this._samples.values()),
      location: Array.from(this._locations.values()),
      function: Array.from(this._functions.values()),
      stringTable: Array.from(this._stringTable.keys()),
      timeNanos: this._timeNanos,
      durationNanos: this._durationNanos,
      period: this._period
    })
  }

  addDuration (nanoseconds) {
    this._durationNanos = nanoseconds
  }

  addString (value) {
    let idx = this._stringTable.get(value)

    if (idx === undefined) {
      idx = this._stringTable.size
      this._stringTable.set(value, idx)
    }

    return idx
  }

  addFunction (functionName, url) {
    const key = `${url}:${functionName}`

    let fn = this._functions.get(key)

    if (!fn) {
      const filename = this.addString(url)
      const name = this.addString(functionName || '(anonymous)')

      fn = new perftools.profiles.Function({
        filename,
        systemName: name,
        id: this._functions.size + 1,
        name
      })

      this._functions.set(key, fn)
    }

    return fn
  }

  // TODO: compute location id
  addLocation (functionId, locationId, lineNumber) {
    const location = new perftools.profiles.Location({
      id: locationId,
      line: [
        new perftools.profiles.Line({
          functionId,
          line: lineNumber + 1 // Runtime.CallFrame is 0-based
        })
      ]
    })

    this._locations.set(locationId, location)

    return location
  }

  addSample (locationId, values) {
    let sample = this._samples.get(locationId)

    if (!sample) {
      const locationIds = []

      let link = locationId

      do {
        locationIds.push(link)
      } while ((link = this._links.get(link)))

      sample = new perftools.profiles.Sample({
        locationId: locationIds,
        value: values
      })

      this._samples.set(locationId, sample)
    } else {
      for (let i = 0; i < values.length; i++) {
        sample.value[i] += values[i]
      }
    }

    return sample
  }

  addLink (locationId, childId) {
    this._links.set(childId, locationId)
  }

  _toSampleType (tuples) {
    return tuples.map(tuple => this._toValueType(tuple))
  }

  _toValueType (tuple) {
    return {
      type: this.addString(tuple[0]),
      unit: this.addString(tuple[1])
    }
  }
}

module.exports = { Profile }
