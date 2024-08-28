'use strict'

const fs = require('node:fs')

module.exports = function (methodName, args, cb) {
  const method = `${methodName}Sync`
  try {
    const res = fs[method](...args)
    cb(res)
  } catch (e) {
    cb(null)
  }
}
