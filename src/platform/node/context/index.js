'use strict'

module.exports = config => {
  let namespace

  if (config.experimental.asyncHooks) {
    namespace = require('./cls_hooked')
  } else {
    namespace = require('./cls')
  }

  return namespace
}
