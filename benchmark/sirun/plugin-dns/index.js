'use strict'

if (Number(process.env.USE_TRACER)) {
  require('../../..').init()
}

const dns = require('dns')

function testRun (count) {
  if (++count === 1000) return
  dns.lookup('localhost', () => testRun(count))
}

testRun(0)
