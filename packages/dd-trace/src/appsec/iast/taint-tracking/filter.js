'use strict'

const NODE_MODULES = 'node_modules'

const isPrivateModule = function (file) {
  return file && file.indexOf(NODE_MODULES) === -1
}

module.exports = {
  isPrivateModule
}
