'use strict'

const assertPromise = require('../../dd-trace/test/plugins/promise')

assertPromise('bluebird')

assertPromise('bluebird', bluebird => {
  // TODO: remove if statement when running tests only for versions ^2.11.0 and ^3.4.1
  // https://github.com/petkaantonov/bluebird/releases/tag/v2.11.0
  // https://github.com/petkaantonov/bluebird/releases/tag/v3.4.1
  if (!bluebird.getNewLibraryCopy) {
    return bluebird
  }

  return bluebird.getNewLibraryCopy()
})
