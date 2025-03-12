'use strict'

const { addHook } = require('./helpers/instrument')

// Empty hook just to make the plugin load.
addHook({ name: 'dd-trace-api' }, api => api)
