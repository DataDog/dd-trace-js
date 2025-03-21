'use strict'

const { addHook } = require('./helpers/instrument')

// Empty hook just to make the plugin load.
// TODO: Add version range when the module is released on npm.
addHook({ name: 'dd-trace-api' }, api => api)
