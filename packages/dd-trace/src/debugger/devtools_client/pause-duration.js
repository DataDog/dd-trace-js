'use strict'

const { workerData } = require('node:worker_threads')

const { PauseDurationHistogram } = require('../pause-duration')

// For testing purposes, we allow `workerData` to be undefined and fallback to a histogram that is never drained
const buffer = workerData?.pauseDurationBuffer ?? PauseDurationHistogram.createBuffer()

/**
 * The worker's view of the pause duration histogram shared with the main thread, which drains it into telemetry.
 *
 * @type {PauseDurationHistogram}
 */
module.exports = new PauseDurationHistogram(buffer)
