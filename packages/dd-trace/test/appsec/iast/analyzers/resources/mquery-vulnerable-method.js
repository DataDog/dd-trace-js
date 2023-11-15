'use strict'

const mquery = require('mquery')

module.exports = function vulnerableMethod (collection, filter, cb) {
  return mquery()
    .find(filter)
    .collection(collection)
    .then(cb).catch(cb)
}
