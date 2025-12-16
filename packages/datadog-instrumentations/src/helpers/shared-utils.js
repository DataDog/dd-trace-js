'use strict'

function isFilePath (moduleName) {
  if (moduleName.startsWith('./') || moduleName.startsWith('../') || moduleName.startsWith('/')) {
    return true
  }

  if (moduleName.includes('/') && !moduleName.includes('node_modules/') && !moduleName.startsWith('@')) {
    return true
  }

  return false
}

module.exports = {
  isFilePath
}
