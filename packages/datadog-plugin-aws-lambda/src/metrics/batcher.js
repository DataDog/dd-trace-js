'use strict'

class Batcher {
  #metrics = new Map()

  /** @param {import('./model').Distribution} metric */
  add (metric) {
    const key = JSON.stringify({
      host: metric.host,
      metricType: metric.metricType,
      name: metric.name,
      tags: [...metric.tags].sort(),
    })
    const previous = this.#metrics.get(key)
    this.#metrics.set(key, previous === undefined ? metric : previous.union(metric))
  }

  /** @returns {import('./model').APIMetric[]} */
  toAPIMetrics () {
    return [...this.#metrics.values()].flatMap(metric => metric.toAPIMetrics())
  }
}

module.exports = { Batcher }
