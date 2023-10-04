'use strict'

module.exports = function vulnerableMethod (collection, filter) {
  // comment to force a vulnerability in line 5 instead of 4
  return collection.find(filter)
}
