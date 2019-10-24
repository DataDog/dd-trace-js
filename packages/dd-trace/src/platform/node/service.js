'use strict'

const path = require('path')
const readPkgUp = require('read-pkg-up')
const parentModule = require('parent-module')

function service () {
  const lambdaFunction = process.env['AWS_LAMBDA_FUNCTION_NAME']
  if (lambdaFunction) {
    return lambdaFunction
  }

  const callerPath = parentModule()
  const parentPath = parentModule(callerPath)
  const cwd = path.dirname(parentPath || callerPath)
  const pkg = findPkg(cwd)

  return pkg.name
}

function findPkg (cwd) {
  let up = readPkgUp.sync({ cwd })

  while (up && /\/node_modules\//.test(up.path)) {
    up = readPkgUp.sync({ cwd: path.resolve(path.dirname(up.path), '..') })
  }

  return up && up.pkg ? up.pkg : {}
}

module.exports = service
