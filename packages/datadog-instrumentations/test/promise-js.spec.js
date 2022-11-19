'use strict'

require('../../dd-trace/test/setup/core')

require('../src/promise-js')

const assertPromise = require('./helpers/promise')

assertPromise('promise-js')
