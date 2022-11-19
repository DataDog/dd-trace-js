'use strict'

require('../../dd-trace/test/setup/tap')

require('../src/promise-js')

const assertPromise = require('./helpers/promise')

assertPromise('promise-js')
