'use strict'

const os = require('node:os')

const request = require('./exporters/common/request')
const log = require('./log')

const SERIES_PATH = '/api/v1/series'
const DISTRIBUTIONS_PATH = '/api/v1/distribution_points'
const SITE_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i

/**
 * Sends the metrics produced by the existing DogStatsD-compatible API directly
 * to Datadog without requiring a local Agent.
 */
class AgentlessMetricsClient {
  #apiKey
  #apiKeyMissingLogged = false
  #distributions = new Map()
  #hostname
  #origin
  #series = []
  #tags

  /**
   * @param {object} options - Agentless metrics options.
   * @param {string} [options.apiKey] - Datadog API key.
   * @param {boolean} [options.reportHostname] - Whether to associate the host with metrics.
   * @param {string} [options.site] - Datadog site.
   * @param {string[]} [options.tags] - Tags applied to every metric.
   */
  constructor ({ apiKey, reportHostname, site = 'datadoghq.com', tags = [] }) {
    this.#apiKey = apiKey
    this.#hostname = reportHostname ? os.hostname() : undefined
    this.#tags = tags

    if (SITE_PATTERN.test(site)) {
      this.#origin = `https://api.${site}`
    } else {
      log.error('Invalid DD_SITE for agentless metrics: %s. Metrics will not be sent.', site)
    }
  }

  /**
   * Records a counter increment.
   *
   * @param {string} stat - Metric name.
   * @param {number} value - Value to add.
   * @param {string[]} [tags] - Metric tags.
   * @returns {void}
   */
  increment (stat, value, tags) {
    this.#addSeries(stat, value, 'count', tags)
  }

  /**
   * Records a counter decrement.
   *
   * @param {string} stat - Metric name.
   * @param {number} value - Value to subtract.
   * @param {string[]} [tags] - Metric tags.
   * @returns {void}
   */
  decrement (stat, value, tags) {
    this.#addSeries(stat, -value, 'count', tags)
  }

  /**
   * Records a gauge value.
   *
   * @param {string} stat - Metric name.
   * @param {number} value - Gauge value.
   * @param {string[]} [tags] - Metric tags.
   * @returns {void}
   */
  gauge (stat, value, tags) {
    this.#addSeries(stat, value, 'gauge', tags)
  }

  /**
   * Records a distribution value.
   *
   * @param {string} stat - Metric name.
   * @param {number} value - Distribution value.
   * @param {string[]} [tags] - Metric tags.
   * @returns {void}
   */
  distribution (stat, value, tags) {
    const allTags = this.#getTags(tags)
    const key = JSON.stringify([stat, allTags])
    let distribution = this.#distributions.get(key)

    if (distribution === undefined) {
      distribution = { metric: stat, values: [], tags: allTags }
      this.#distributions.set(key, distribution)
    }

    distribution.values.push(value)
  }

  /**
   * Records a histogram value as a distribution.
   *
   * @param {string} stat - Metric name.
   * @param {number} value - Histogram value.
   * @param {string[]} [tags] - Metric tags.
   * @returns {void}
   */
  histogram (stat, value, tags) {
    this.distribution(stat, value, tags)
  }

  /**
   * Flushes all buffered metrics to the direct intake endpoints.
   *
   * @returns {void}
   */
  flush () {
    if (this.#series.length === 0 && this.#distributions.size === 0) return

    const series = this.#series
    const distributions = this.#distributions
    this.#series = []
    this.#distributions = new Map()

    if (!this.#apiKey) {
      if (!this.#apiKeyMissingLogged) {
        this.#apiKeyMissingLogged = true
        log.error('DD_API_KEY is required for agentless metrics. Metrics will not be sent.')
      }
      return
    }

    if (!this.#origin) return

    const timestamp = Math.floor(Date.now() / 1000)

    if (series.length > 0) {
      for (const metric of series) {
        metric.points = [[timestamp, metric.value]]
        delete metric.value
        if (this.#hostname) metric.host = this.#hostname
      }
      this.#send(SERIES_PATH, { series }, 'metrics')
    }

    if (distributions.size > 0) {
      const distributionSeries = []
      for (const distribution of distributions.values()) {
        const metric = {
          metric: distribution.metric,
          points: [[timestamp, distribution.values]],
          tags: distribution.tags,
          type: 'distribution',
        }
        if (this.#hostname) metric.host = this.#hostname
        distributionSeries.push(metric)
      }
      this.#send(DISTRIBUTIONS_PATH, { series: distributionSeries }, 'metric distributions')
    }
  }

  /**
   * Buffers a time-series metric.
   *
   * @param {string} stat - Metric name.
   * @param {number} value - Metric value.
   * @param {'count'|'gauge'} type - Datadog metric type.
   * @param {string[]} [tags] - Metric tags.
   * @returns {void}
   */
  #addSeries (stat, value, type, tags) {
    this.#series.push({
      metric: stat,
      value,
      tags: this.#getTags(tags),
      type,
    })
  }

  /**
   * Combines global and per-metric tags without modifying either input.
   *
   * @param {string[]} [tags] - Per-metric tags.
   * @returns {string[]} Combined tags.
   */
  #getTags (tags) {
    if (!tags?.length) return this.#tags
    if (this.#tags.length === 0) return tags
    return [...this.#tags, ...tags]
  }

  /**
   * Sends one JSON payload to a Datadog metrics endpoint.
   *
   * @param {string} path - Intake path.
   * @param {object} payload - Metrics payload.
   * @param {string} kind - Payload kind used in error messages.
   * @returns {void}
   */
  #send (path, payload, kind) {
    let body
    try {
      body = JSON.stringify(payload)
    } catch (error) {
      log.error('Failed to encode agentless %s: %s', kind, error.message)
      return
    }

    request(body, {
      method: 'POST',
      url: this.#origin,
      path,
      headers: {
        'Content-Type': 'application/json',
        'DD-API-KEY': this.#apiKey,
      },
    }, error => {
      if (error) log.error('Failed to send agentless %s: %s', kind, error.message)
    })
  }
}

module.exports = AgentlessMetricsClient
