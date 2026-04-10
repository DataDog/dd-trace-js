'use strict'

const { addHook } = require('./helpers/instrument')

// Register a hook for the main entry point so RITM fires the loadChannel,
// enabling the plugin manager to discover and configure the plugin.
// The actual code instrumentation is done by the orchestrion rewriter.
addHook({ name: '@aws/durable-execution-sdk-js', versions: ['>=1.1.0'] }, exports => exports)
