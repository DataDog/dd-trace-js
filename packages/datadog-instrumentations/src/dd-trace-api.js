'use strict'

const { addHook } = require('./helpers/instrument')

// Empty hook just to make the plugin load.
// Version 1.0.1 re-publishes tracer initialization after the plugin subscribes.
addHook({ name: 'dd-trace-api', versions: ['>=1.0.1'] }, api => api)
