'use strict'

const fs = require('fs')

module.exports = function (methodName, args, cb) {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line n/handle-callback-err
    fs[methodName](...args, (err, res) => {
      resolve(cb(res))
    })
  })
}
