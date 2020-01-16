'use strict'

const assertPromise = require('../../dd-trace/test/plugins/promise')

assertPromise('bluebird')

assertPromise('bluebird', bluebird => bluebird.getNewLibraryCopy(), '^2.11.0 || ^3.4.1')

assertPromise('bluebird', bluebird => bluebird.getNewLibraryCopy().getNewLibraryCopy(), '^2.11.0 || ^3.4.1')
