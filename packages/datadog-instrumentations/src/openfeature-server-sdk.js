'use strict'

const bridge = require('../../dd-trace/src/openfeature/server-sdk-bridge')
const { addHook } = require('./helpers/instrument')

// The vendored `@datadog/openfeature-node-server` build cannot see the customer's own
// `@openfeature/server-sdk` install (see `vendor/rspack.config.js`), so this captures the
// customer's actual required instance and writes it into the shared bridge module.
addHook({ name: '@openfeature/server-sdk' }, moduleExports => {
  bridge.setEventEmitter(moduleExports.OpenFeatureEventEmitter)
  bridge.ProviderEvents = moduleExports.ProviderEvents

  return moduleExports
})
