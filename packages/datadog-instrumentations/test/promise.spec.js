'use strict'

require('../../dd-trace/test/setup/core')

require('../src/promise')

const assertPromise = require('./helpers/promise')

assertPromise('promise')
