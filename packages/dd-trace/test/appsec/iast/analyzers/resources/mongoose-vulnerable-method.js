'use strict'

module.exports = function vulnerableMethod (Test, filter, cb) {
  Test.find(filter).then(cb)
}
