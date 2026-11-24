'use strict'

/**
 * @typedef {{ timestamp: Date, value: number }} MetricPoint
 * @typedef {{ metric: string, points: Array<[number, number[]]>, tags: string[], type: string }} APIMetric
 */
class Distribution {
  metricType = 'distribution'

  /**
   * @param {string} name
   * @param {MetricPoint[]} points
   * @param {string[]} tags
   */
  constructor (name, points, ...tags) {
    this.name = name
    this.points = points
    this.tags = tags
  }

  /** @returns {APIMetric[]} */
  toAPIMetrics () {
    return [{
      metric: this.name,
      points: this.points.map(point => [Math.floor(point.timestamp.getTime() / 1000), [point.value]]),
      tags: this.tags,
      type: this.metricType,
    }]
  }

  /** @param {Distribution} metric */
  union (metric) {
    if (metric.metricType !== 'distribution') return this
    const distribution = new Distribution(this.name, this.points)
    return Object.assign(distribution, this, { points: [...this.points, ...metric.points] })
  }
}

module.exports = { Distribution }
