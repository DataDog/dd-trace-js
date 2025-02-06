'use strict'

const fs = require('fs')

module.exports = function (methodName, args, cb) {
  return new Promise((resolve, reject) => {
    fs[methodName](...args, (err, res) => {
      resolve(cb(res))
    })
  })
}
