'use strict'

const assert = require('node:assert/strict')

if (Number(process.env.USE_TRACER)) {
  require('../../..').init()
}

const dns = require('dns')

// Total lookups per process. The tracer's dns instrumentation is paid per lookup,
// so a large total keeps the fixed tracer load a small fraction of the run. The
// lookups are serialized, so live memory stays flat regardless of COUNT.
const COUNT = process.env.COUNT ? Number(process.env.COUNT) : 20000

let checked = false

function testRun (count) {
  if (++count === COUNT) return
  dns.lookup('localhost', (error, address) => {
    if (!checked) {
      assert.ok(!error && address, 'dns.lookup did not resolve localhost')
      checked = true
    }
    testRun(count)
  })
}

testRun(0)
