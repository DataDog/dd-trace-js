'use strict'

/**
 * @param {string} name
 * @param {number} value
 * @param {Date} metricTime
 * @param {string[]} tags
 */
function buildMetricLog (name, value, metricTime, tags) {
  return `${JSON.stringify({ e: Math.floor(metricTime.getTime() / 1000), m: name, t: tags, v: value })}\n`
}

/**
 * @param {string} name
 * @param {number} value
 * @param {Date} metricTime
 * @param {string[]} tags
 */
function writeMetricToStdout (name, value, metricTime, tags) {
  // console.log prefixes metadata which the metric log forwarder cannot parse.
  process.stdout.write(buildMetricLog(name, value, metricTime, tags))
}

module.exports = { buildMetricLog, writeMetricToStdout }
