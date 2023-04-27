'use strict'

// TODO: use datadog-core storage instead
const { AsyncLocalStorage } = require('async_hooks')

module.exports = new AsyncLocalStorage()
