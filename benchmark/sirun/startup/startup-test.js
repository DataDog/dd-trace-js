'use strict'

const assert = require('node:assert/strict')

if (Number(process.env.USE_TRACER)) {
  require('../../..').init()
}

if (Number(process.env.EVERYTHING)) {
  require('./everything-fixture')

  assert.ok(
    require.cache[require.resolve('./everything-fixture/node_modules/express')],
    'everything-fixture did not load (express not in require cache)'
  )
}
