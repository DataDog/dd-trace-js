'use strict'

const NODE_MODULES = 'node_modules'

const isPrivateModule = function (file) {
  return file && file.indexOf(NODE_MODULES) === -1
}

let isNotLibraryFile = function (file) {
  return file && file.indexOf('dd-trace-js') === -1 && file.indexOf('dd-trace') === -1
}

if (process.env.PLUGINS) {
  // We're most likely in test mode, so allow for modules inside the tested
  // modules directory, which is `versions`
  isNotLibraryFile = function (file) {
    if (!file) {
      return false
    }
    if (file.indexOf('dd-trace-js/versions/') !== -1) {
      return true
    }
    return file.indexOf('dd-trace-js') === -1 && file.indexOf('dd-trace') === -1
  }
}

module.exports = {
  isPrivateModule,
  isNotLibraryFile
}
