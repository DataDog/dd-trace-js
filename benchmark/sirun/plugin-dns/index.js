'use strict'

if (Number(process.env.USE_TRACER)) {
  require('../../..').init()
}

const dns = require('dns')

// Total lookups per process. The tracer's dns instrumentation is paid per lookup,
// so a large total keeps the fixed tracer load a small fraction of the run. The
// lookups are serialized, so live memory stays flat regardless of COUNT.
const COUNT = process.env.COUNT ? Number(process.env.COUNT) : 20000

function testRun (count) {
  if (++count === COUNT) return
  dns.lookup('localhost', () => testRun(count))
}

testRun(0)
