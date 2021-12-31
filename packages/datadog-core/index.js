'use strict'

const LocalStorage = require('./src/storage')
const util = require('./src/util')

const storage = new LocalStorage()

module.exports = { storage, ...util }
