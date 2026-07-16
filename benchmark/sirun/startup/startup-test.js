'use strict'

const assert = require('node:assert/strict')

if (Number(process.env.USE_TRACER)) {
  require('../../..').init()
}

if (Number(process.env.EVERYTHING)) {
  if (Number(process.env.ESM)) {
    // The ESM variant registers the iitm ESM loader through
    // NODE_OPTIONS=--import ../../../register.js, so importing the fixture routes
    // every dependency and its transitive graph through the loader's resolve/load
    // hooks. The CJS branch below goes through require-in-the-middle and never
    // touches the ESM loader, so this is the only startup variant that measures
    // the synchronous-vs-asynchronous loader cost the iitm hooks change.
    assert.match(
      process.env.NODE_OPTIONS ?? '',
      /--import\b.+register\.js/,
      'ESM startup variant must register the iitm loader via --import register.js'
    )
    // The floating import is the measured workload: it keeps the process alive
    // until the graph finishes loading, and a rejection surfaces as a non-zero exit.
    import('./everything-fixture/index.mjs')
  } else {
    require('./everything-fixture')

    assert.ok(
      require.cache[require.resolve('./everything-fixture/node_modules/express')],
      'everything-fixture did not load (express not in require cache)'
    )
  }
}
