#!/usr/bin/env node
'use strict'

// Entry for `build-and-test-openfeature.js`. Enables the flagging provider through the
// public API so the bundled `flagging_provider.js` exercises the optional peer load at
// runtime. A broken resolution leaves `tracer.openfeature` on the no-op provider (#8980);
// a working one loads the real `FlaggingProvider`.

const assert = require('assert')

const tracer = require('../../').init({ // dd-trace
  experimental: { flaggingProvider: { enabled: true } },
})

const provider = tracer.openfeature

assert.strictEqual(
  provider?.constructor?.name,
  'FlaggingProvider',
  `expected the real Datadog FlaggingProvider, got ${provider?.constructor?.name}`
)

// eslint-disable-next-line no-console
console.log('PROVIDER_OK')
process.exit(0)
