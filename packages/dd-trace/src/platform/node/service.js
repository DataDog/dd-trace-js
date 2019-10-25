'use strict'

const path = require('path')
const readPkgUp = require('read-pkg-up')
const parentModule = require('parent-module')

function service () {
  const callerPath = parentModule()
  const parentPath = parentModule(callerPath)
  const cwd = path.dirname(parentPath || callerPath)
  const pkg = findPkg(cwd)

  return pkg.name
}

function findPkg (cwd) {
  let up = readPkgUp.sync({ cwd })

  while (up && isDependency(up.path)) {
    cwd = path.resolve(path.dirname(up.path), '..')
    up = readPkgUp.sync({ cwd })
  }

  return up && up.pkg ? up.pkg : {}
}

function isDependency (filepath) {
  const expr = new RegExp(`\\${path.sep}node_modules\\${path.sep}`)
  return expr.test(filepath)
}

module.exports = service
