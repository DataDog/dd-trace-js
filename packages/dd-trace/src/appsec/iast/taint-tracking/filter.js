'use strict'

const NODE_MODULES = 'node_modules'

const isPrivateModule = function (file) {
  return file && !file.includes(NODE_MODULES)
}

const isNotLibraryFile = function (file) {
  return file && !file.includes('dd-trace-js') && !file.includes('dd-trace')
}

module.exports = {
  isPrivateModule,
  isNotLibraryFile
}
