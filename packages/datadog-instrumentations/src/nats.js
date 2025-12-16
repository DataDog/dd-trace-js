'use strict'

const {
  addHook,
  getHooks
} = require('./helpers/instrument')

// Register hooks for orchestrion (publish and processMsg)
// NOTE: request() instrumentation is NOT supported due to NATS internal architecture.
// Any wrapping of request() breaks the internal inbox/reply correlation mechanism.
// This is a known limitation documented in the integration.
for (const hook of getHooks('nats')) {
  addHook(hook, exports => exports)
}
