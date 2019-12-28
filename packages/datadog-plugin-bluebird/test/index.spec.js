'use strict'

const assertPromise = require('../../dd-trace/test/plugins/promise')

assertPromise('bluebird')

// TODO: add version requirments for ^2.11.0 and ^3.4.1
// https://github.com/petkaantonov/bluebird/releases/tag/v2.11.0
// https://github.com/petkaantonov/bluebird/releases/tag/v3.4.1

assertPromise('bluebird', bluebird => {
  // TODO: remove undefined check after adding versions requirements above
  if (!bluebird.getNewLibraryCopy) {
    return bluebird
  }

  return bluebird.getNewLibraryCopy()
})
