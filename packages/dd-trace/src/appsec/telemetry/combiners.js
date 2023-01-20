'use strict'

const MAX_QUEUE_SIZE = 1000

class Point {
  constructor (value, timestamp = Math.floor(Date.now() / 1000)) {
    this.value = value
    this.timestamp = timestamp
  }
}

class ConflatedCombiner {
  constructor () {
    // TODO: should be a BigInt?
    this.value = 0
  }

  add (value) {
    this.value += value
  }

  drain () {
    const current = this.value
    this.value = 0
    return current !== 0 ? [new Point(current)] : []
  }

  merge (metricData) {
    if (metricData && metricData.points) {
      const total = metricData.points.map(point => point.value).reduce((total, value) => total + value)
      this.add(total)
    }
  }
}

class AggregatedCombiner {
  constructor () {
    this.value = []
  }

  add (value) {
    this.value.push(new Point(value))
    if (this.value.length === MAX_QUEUE_SIZE) {
      this.value.shift()
    }
  }

  drain () {
    const current = this.value
    this.value = []
    return current
  }

  merge (metricData) {
    if (metricData && metricData.points) {
      this.value.push(...metricData.points)
    }
  }
}

module.exports = {
  ConflatedCombiner,
  AggregatedCombiner,
  Point
}
