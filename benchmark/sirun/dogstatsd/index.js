'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const { DogStatsDClient, MetricsAggregationClient } = require('../../../packages/dd-trace/src/dogstatsd')

const { VARIANT } = process.env
const OPERATIONS = Number(process.env.OPERATIONS)

// Every metric the tracer emits (runtime metrics, custom metrics) runs through
// DogStatsDClient._add: build the `stat:value|type` line, splice the global and
// per-metric tags, and append to the 1KB datagram buffer (Buffer.from on each
// overflow). The aggregated variant drives the MetricsAggregationClient tag
// tree that runtime metrics build before flushing. The UDP socket is stubbed so
// nothing leaves the process — the bench measures the in-process formatting,
// buffering, and send boundary only.
const sockets = []
let lastPayload

function discard () {}

class BenchClient extends DogStatsDClient {
  _socket () {
    const socket = {
      send (buffer) { lastPayload = buffer },
      on () {},
      unref () {},
    }

    sockets.push(socket)

    return socket
  }
}

const client = new BenchClient({
  host: '127.0.0.1',
  port: 8125,
  tags: ['env:bench', 'service:web-app', 'version:1.2.3'],
  lookup: (host, cb) => cb(null, host, 4),
})

const NAME = 'runtime.node.event_loop.delay.max'
const FEW_TAGS = ['lang:javascript', 'lang_version:20.0.0']
const MANY_TAGS = []
for (let i = 0; i < 12; i++) MANY_TAGS.push(`dim_${i}:value_${i}`)

function preflight () {
  client._add(NAME, 42, 'g', FEW_TAGS)
  client.flush()
  const payload = lastPayload.toString()
  assert.ok(payload.includes(NAME) && payload.includes('env:bench'),
    '_add did not format the metric line with global tags')

  for (const socket of sockets) socket.send = discard
}
preflight()

guard.loopStart()
if (VARIANT === 'aggregated') {
  // The runtime-metrics path: accumulate into the tag tree, then flush walks the
  // tree and formats every node through the client. Stubbed socket on flush.
  const agg = new MetricsAggregationClient(client)
  for (let i = 0; i < OPERATIONS; i++) {
    agg.count(NAME, 1, FEW_TAGS)
    agg.gauge('runtime.node.mem.heap_used', i, FEW_TAGS)
    if ((i & 0x3FF) === 0) agg.flush()
  }
  agg.flush()
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
