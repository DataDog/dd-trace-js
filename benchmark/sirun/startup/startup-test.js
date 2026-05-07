'use strict'

const assert = require('node:assert/strict')

if (Number(process.env.USE_TRACER)) {
  require('../../..').init()
}

if (Number(process.env.EVERYTHING)) {
  // The fixture is a self-contained sub-project (`everything-fixture/`) with
  // its own `package.json`/`package-lock.json`/`node_modules/`. That keeps the
  // bench independent of dd-trace's own dependency tree (vendored modules,
  // optional native deps, hoisting layout) so adding/removing a tracer
  // dependency cannot silently break or skew this measurement.
  require('./everything-fixture')

  // Pre-flight sanity: confirm the fixture really loaded a representative
  // package. Catches the "fixture didn't install / was loaded as a no-op"
  // failure mode that would otherwise produce a fast, green, meaningless run.
  assert.ok(require.cache[require.resolve('./everything-fixture/node_modules/express')])
}
