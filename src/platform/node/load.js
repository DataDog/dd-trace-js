'use strict'

const path = require('path')
const readPkgUp = require('read-pkg-up')
const parentModule = require('parent-module')
const semver = require('semver')

const SUPPORTED_VERSIONS = '^4.7 || ^6.9 || >=8'

function load () {
  if (!semver.satisfies(process.versions.node, SUPPORTED_VERSIONS)) {
    throw new Error([
      `Node ${process.versions.node} is not supported.`,
      `Only versions of Node matching "${SUPPORTED_VERSIONS}" are supported.`,
      `Tracing has been disabled.`
    ].join(' '))
  }

  const callerPath = parentModule()
  const parentPath = parentModule(callerPath)
  const cwd = path.dirname(parentPath || callerPath)
  const pkg = readPkgUp.sync({ cwd }).pkg || {}

  this._service = pkg.name
}

module.exports = load
