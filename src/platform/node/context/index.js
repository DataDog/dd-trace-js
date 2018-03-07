'use strict'

const clsBluebird = require('cls-bluebird')

module.exports = config => {
  let namespace

  if (config.experimental.asyncHooks) {
    namespace = require('./cls_hooked')
  } else {
    namespace = require('./cls')
  }

  clsBluebird(namespace)

  return namespace
}
