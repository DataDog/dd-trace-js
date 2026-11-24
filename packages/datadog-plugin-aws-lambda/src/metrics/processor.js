'use strict'

/* eslint-disable no-await-in-loop -- One sequential batch sender and its completion barrier. */

const retry = require('retry')

const log = require('../../../dd-trace/src/log')
const { Batcher } = require('./batcher')
const { Timer } = require('./timer')

class Processor {
  #client
  #timer
  #shouldRetry
  #retryIntervalMs
  #batcher = new Batcher()
  #loopPromise

  /**
   * @param {{ sendMetrics(metrics: import('./model').APIMetric[]): Promise<void> }} client
   * @param {number} intervalMs
   * @param {boolean} shouldRetry
   * @param {number} [retryIntervalMs]
   */
  constructor (client, intervalMs, shouldRetry, retryIntervalMs = 250) {
    this.#client = client
    this.#timer = new Timer(intervalMs)
    this.#shouldRetry = shouldRetry
    this.#retryIntervalMs = retryIntervalMs
  }

  startProcessing () {
    if (this.#loopPromise !== undefined) return
    this.#timer.start()
    this.#loopPromise = this.#sendMetricsLoop()
  }

  /** @param {import('./model').Distribution} metric */
  addMetric (metric) {
    this.#batcher.add(metric)
  }

  async flush () {
    this.#timer.complete()
    if (this.#loopPromise === undefined) this.#loopPromise = this.#sendMetricsLoop()
    await this.#loopPromise
  }

  async #sendMetricsLoop () {
    while (!(await this.#timer.nextTimeout())) {
      const previous = this.#batcher
      this.#batcher = new Batcher()
      const metrics = previous.toAPIMetrics()
      if (metrics.length === 0) continue
      try {
        await this.#client.sendMetrics(metrics)
      } catch {
        if (this.#shouldRetry) {
          const received = this.#batcher.toAPIMetrics().length
          if (received > 0) {
            log.warn('Failed to send metrics to Datadog, retrying at next interval. %s metrics received will be lost',
              received)
          }
          // Source behavior: restoring the failed batch discards metrics received during that send.
          this.#batcher = previous
        }
      }
    }

    const metrics = this.#batcher.toAPIMetrics()
    if (metrics.length === 0) return
    await new Promise((resolve, reject) => {
      const operation = retry.operation({
        minTimeout: this.#retryIntervalMs,
        maxTimeout: this.#retryIntervalMs,
        retries: this.#shouldRetry ? 2 : 0,
      })
      operation.attempt(() => {
        Promise.resolve().then(() => this.#client.sendMetrics(metrics)).then(resolve, () => {
          const error = new Error('Failed to send metrics to Datadog')
          if (!operation.retry(error)) reject(error)
        })
      })
    })
  }
}

module.exports = { Processor }
