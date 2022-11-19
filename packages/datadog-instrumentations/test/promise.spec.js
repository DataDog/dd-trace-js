'use strict'

require('../../dd-trace/test/setup/tap')

require('../src/promise')

const assertPromise = require('./helpers/promise')

assertPromise('promise')
