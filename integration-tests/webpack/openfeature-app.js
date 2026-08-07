#!/usr/bin/env node
'use strict'

// Entry for `build-and-test-openfeature.js`. The flagging provider now ships vendored
// inside dd-trace itself (see `vendor/rspack.config.js`), so enabling it through the public
// API must keep working once bundled -- there is no longer an optional peer to lose.
// `@openfeature/server-sdk` is bundled (inlined) here rather than marked external, so this
// also exercises whether the generic bundler instrumentation mechanism still lets dd-trace's
// `openfeature-server-sdk` require-hook observe the app's own inlined require, bridging the
// real `ProviderEvents`/`OpenFeatureEventEmitter` into the vendored provider instead of
// leaving it on the deferred, event-dropping stand-in.

// eslint-disable-next-line import/order
const tracer = require('../../').init({ // dd-trace
  experimental: { flaggingProvider: { enabled: true } },
})

const assert = require('assert')

const provider = tracer.openfeature

assert.strictEqual(
  provider?.constructor?.name,
  'FlaggingProvider',
  `expected the real Datadog FlaggingProvider, got ${provider?.constructor?.name}`
)

// Must be required after dd-trace has initialized: dd-trace's require-hook instrumentation
// (`openfeature-server-sdk.js`) only bridges the real emitter into the vendored provider if
// its hook is already installed by the time the app requires `@openfeature/server-sdk`.
const { ProviderEvents } = require('@openfeature/server-sdk')

let receivedDetails
provider.events.addHandler(ProviderEvents.Ready, (details) => {
  receivedDetails = details
})
provider.events.emit(ProviderEvents.Ready, { fired: true })

assert.deepStrictEqual(
  receivedDetails,
  { fired: true },
  'the openfeature-server-sdk instrumentation did not bridge the real emitter into the bundled provider'
)

// eslint-disable-next-line no-console
console.log('PROVIDER_OK')
process.exit(0)
