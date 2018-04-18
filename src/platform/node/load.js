'use strict'

const path = require('path')
const readPkgUp = require('read-pkg-up')
const parentModule = require('parent-module')

function load () {
  const callerPath = parentModule()
  const parentPath = parentModule(callerPath)
  const pkg = readPkgUp.sync({ cwd: path.dirname(parentPath) }).pkg

  this._service = pkg.name
}

module.exports = load
