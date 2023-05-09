'use strict'

const { AsyncLocalStorage } = require('async_hooks')

const storage = new AsyncLocalStorage()

module.exports = { storage }
