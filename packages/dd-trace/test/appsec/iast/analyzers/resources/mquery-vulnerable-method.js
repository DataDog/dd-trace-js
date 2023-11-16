'use strict'

function vulnerableFind (mquery, collection, filter) {
  return mquery()
    .collection(collection)
    .find(filter)
}

function vulnerableFindOne (mquery, collection, filter) {
  return mquery()
    .collection(collection)
    .findOne(filter)
}

module.exports = {
  vulnerableFind,
  vulnerableFindOne
}
