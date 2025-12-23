'use strict'

function isRelativeRequire (moduleName) {
  return moduleName.startsWith('./') || moduleName.startsWith('../')
}

module.exports = {
  isRelativeRequire
}
