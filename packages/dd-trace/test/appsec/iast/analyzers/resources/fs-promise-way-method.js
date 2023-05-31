'use strict'

const fs = require('fs')

module.exports = function (methodName, args, cb) {
  return fs.promises[methodName](...args).then(cb).catch(cb)
}
