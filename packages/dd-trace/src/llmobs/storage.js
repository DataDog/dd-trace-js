'use strict'

// TODO: remove this and use namespaced storage once available
const { AsyncLocalStorage } = require('async_hooks')
const storage = new AsyncLocalStorage()

module.exports = { storage }
