'use strict'

const NODE_MODULES = 'node_modules'

const isPrivateModule = function (file) {
  return file && !file.includes(NODE_MODULES)
}

const isDdTrace = function (file) {
  return Boolean(file?.includes('dd-trace'))
}

module.exports = {
  isPrivateModule,
  isDdTrace
}
