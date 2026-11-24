'use strict'

const log = require('../../../dd-trace/src/log')

const METRICS_QUEUE_LIMIT = 1024

/**
 * @typedef {{ name: string, value: number, tags: string[], metricTime?: Date }} MetricParameters
 */
class MetricsQueue {
  #queue = []

  /** @param {MetricParameters} metric */
  push (metric) {
    log.debug('Metrics Listener was not initialized. Enqueuing metric for later processing.')
    if (this.#queue.length >= METRICS_QUEUE_LIMIT) {
      log.warn('Metrics queue is full, dropping all metrics.')
      this.reset()
    }
    this.#queue.push(metric)
  }

  /** @returns {MetricParameters|undefined} */
  pop () {
    return this.#queue.pop()
  }

  reverse () {
    this.#queue.reverse()
  }

  reset () {
    this.#queue = []
  }

  get length () {
    return this.#queue.length
  }
}

module.exports = { MetricsQueue, METRICS_QUEUE_LIMIT }
