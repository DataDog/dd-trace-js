'use strict'

const fs = require('fs')

function main (methodName, args, cb) {
  return new Promise((resolve, reject) => {
    fs[methodName](...args, (err, res) => {
      resolve(cb(res))
    })
  })
}

main.doubleCallIgnoringCb = function (methodName, args) {
  return new Promise((resolve) => {
    fs[methodName](...args, () => {})
    fs[methodName](...args, () => {
      resolve()
    })
  })
}

module.exports = main
