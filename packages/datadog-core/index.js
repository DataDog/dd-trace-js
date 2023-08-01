'use strict'

const AsyncLocalStorage = require('./src/storage')

const storage = new AsyncLocalStorage()

module.exports = { storage, AsyncLocalStorage }
