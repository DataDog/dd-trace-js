'use strict'

const NODE_MODULES = 'node_modules'

const isPrivateModule = function (file) {
  return file && file.indexOf(NODE_MODULES) === -1
}

const isDdTrace = function (file) {
  return file && (file.indexOf('dd-trace-js') !== -1 || file.indexOf('dd-trace') !== -1)
}

module.exports = {
  isPrivateModule,
  isDdTrace
}
