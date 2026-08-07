'use strict'

const { workerData } = require('node:worker_threads')

require('../noop-request')

const COMPLETED_PROBE_INDEX = 0
const CAPTURED_PROBE_INDEX = 1
const probeCounts = new Int32Array(workerData.probeCountBuffer)
const sendPath = require.resolve('../../../packages/dd-trace/src/debugger/devtools_client/send')

require.cache[sendPath] = { exports: sendAndCount }
require('../../../packages/dd-trace/src/debugger/devtools_client')

/**
 * Record the payload after the production worker has captured the probe state.
 * The downstream exporter is outside the instrumented application's hot path.
 *
 * @param {string} message
 * @param {Record<string, unknown>} logger
 * @param {Record<string, unknown> | undefined} dd
 * @param {Record<string, unknown>} snapshot
 * @returns {void}
 */
function sendAndCount (message, logger, dd, snapshot) {
  if (snapshot.captures !== undefined) Atomics.add(probeCounts, CAPTURED_PROBE_INDEX, 1)
  Atomics.add(probeCounts, COMPLETED_PROBE_INDEX, 1)
  Atomics.notify(probeCounts, COMPLETED_PROBE_INDEX)
}
