'use strict'

const assertPromise = require('../../dd-trace/test/plugins/promise')

assertPromise('bluebird')

// TODO: check when this was introduced, 1 test failing for 2.0.2 version but not 3.7
assertPromise('bluebird', bluebird => {
  return bluebird.getNewLibraryCopy()
})
