'use strict'

const mquery = require('mquery')

function vulnerableFind (collection, filter, cb) {
  return mquery()
    .find(filter)
    .collection(collection)
    .then(cb).catch(cb)
}

function vulnerableFindOne (collection, filter, cb) {
  return mquery()
    .findOne(filter)
    .collection(collection)
    .then(cb).catch(cb)
}

module.exports = {
  vulnerableFind,
  vulnerableFindOne
}
