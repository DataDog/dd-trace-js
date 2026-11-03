'use strict'

const assert = require('node:assert/strict')

const guard = require('../startup-guard')

const { BASELINE_OR_CANDIDATE, VARIANT } = process.env
const OPERATIONS = Number(process.env.OPERATIONS)
const WITH_AGGREGATION = VARIANT === 'aggregated'

// Keep transport I/O outside the measured formatting and aggregation path.
const sockets = []
const payloads = []

function discard () {}

/**
 * @param {Buffer} buffer - Datagram payload
 */
function capture (buffer) {
  payloads.push(buffer)
}

const {
  DogStatsDClient,
  MetricsAggregationClient,
} = require('../../../packages/dd-trace/src/dogstatsd')

class BenchClient extends DogStatsDClient {
  /**
   * @returns {object} Stubbed UDP socket
   */
  _socket () {
    const socket = { send: capture, on () {}, unref () {} }

    sockets.push(socket)

    return socket
  }
}

/**
 * @param {string} host - DogStatsD host
 * @param {(error: null, address: string, family: number) => void} callback - Lookup completion
 */
function lookup (host, callback) {
  callback(null, host, 4)
}

const options = {
  host: '127.0.0.1',
  port: 8125,
  tags: ['env:bench', 'service:web-app', 'version:1.2.3'],
  lookup,
}
const client = new BenchClient(options, WITH_AGGREGATION)
const aggregationClient = new MetricsAggregationClient(client)

const NAME = 'runtime.node.event_loop.delay.max'
const FEW_TAGS = ['lang:javascript', 'lang_version:20.0.0']
const MANY_TAGS = []
for (let i = 0; i < 12; i++) {
  MANY_TAGS.push(`dim_${i}:value_${i}`)
}

function preflight () {
  if (WITH_AGGREGATION) {
    aggregationClient.gauge(NAME, 42, FEW_TAGS)
    aggregationClient.flush(true)
  } else {
    client._add(NAME, 42, 'g', FEW_TAGS)
    client.flush()
  }

  const payload = Buffer.concat(payloads).toString()
  assert.ok(payload.includes(NAME) && payload.includes('env:bench'), 'the metric did not reach the transport')
  // The older baseline source predates client telemetry, but candidate and local runs must exercise it.
  if (WITH_AGGREGATION && BASELINE_OR_CANDIDATE !== 'baseline') {
    assert.ok(payload.includes('datadog.dogstatsd.client.metrics:'), 'client telemetry is not enabled')
  }

  for (const socket of sockets) socket.send = discard
  payloads.length = 0
}
preflight()

guard.loopStart()
if (WITH_AGGREGATION) {
  // The runtime-metrics path: accumulate into the tag tree, then flush walks the
  // tree and formats every node through the client. Stubbed socket on flush.
  for (let i = 0; i < OPERATIONS; i++) {
    aggregationClient.count(NAME, 1, FEW_TAGS)
    aggregationClient.gauge('runtime.node.mem.heap_used', i, FEW_TAGS)
    if ((i & 0x3FF) === 0) aggregationClient.flush()
  }
  aggregationClient.flush()
} else {
  const tags = VARIANT === 'no-tags' ? undefined : (VARIANT === 'many-tags' ? MANY_TAGS : FEW_TAGS)
  const type = VARIANT === 'no-tags' ? 'c' : 'g'
  for (let i = 0; i < OPERATIONS; i++) {
    client._add(NAME, i, type, tags)
    // Flush through the stubbed transport so memory stays flat.
    if ((i & 0x7FF) === 0) client.flush()
  }
}
guard.done()
