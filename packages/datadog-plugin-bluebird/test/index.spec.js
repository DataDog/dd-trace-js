'use strict'

const assertPromise = require('../../dd-trace/test/plugins/promise')

assertPromise('bluebird')

assertPromise('bluebird', bluebird => { return bluebird.getNewLibraryCopy() }, '^2.11.0 || ^3.4.1')
