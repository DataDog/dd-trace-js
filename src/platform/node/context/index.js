'use strict'

module.exports = function () {
  let namespace

  if (this._config.asyncHooks) {
    namespace = require('./cls_hooked')
  } else {
    namespace = require('./cls')
  }

  return namespace
}
