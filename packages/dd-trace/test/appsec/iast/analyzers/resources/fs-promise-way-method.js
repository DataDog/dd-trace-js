'use strict'

const fs = require('node:fs')

module.exports = function (methodName, args, cb) {
  return fs.promises[methodName](...args).then(cb).catch(cb)
}
