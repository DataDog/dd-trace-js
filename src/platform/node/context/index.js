'use strict'

module.exports = config => {
  if (config.experimental.asyncHooks) {
    return require('./cls_hooked')
  } else {
    return require('./cls')
  }
}
