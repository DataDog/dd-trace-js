'use strict'

const path = require('path')
const { readPackageUpSync } = require('read-pkg-up')

function findRoot () {
  return require.main && require.main.filename ? path.dirname(require.main.filename) : process.cwd()
}

function findPkg () {
  const cwd = findRoot()
  const up = readPackageupSync({ cwd })

  return up && up.pkg ? up.pkg : {}
}

module.exports = findPkg()
