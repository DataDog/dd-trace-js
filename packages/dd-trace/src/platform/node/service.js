'use strict'

const path = require('path')
const readPkgUp = require('read-pkg-up')
const parentModule = require('parent-module')

function service () {
  const callerPath = parentModule()
  const parentPath = parentModule(callerPath)
  const cwd = path.dirname(parentPath || callerPath)
  const pkg = readPkgUp.sync({ cwd }).pkg || {}

  return pkg.name
}

module.exports = service
