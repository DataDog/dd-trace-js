'use strict'

require('../../dd-trace/test/setup/tap')

require('../src/bluebird')

const assertPromise = require('./helpers/promise')

assertPromise('bluebird')

assertPromise('bluebird', bluebird => bluebird.getNewLibraryCopy(), '^2.11.0 || ^3.4.1')

assertPromise('bluebird', bluebird => bluebird.getNewLibraryCopy().getNewLibraryCopy(), '^2.11.0 || ^3.4.1')
