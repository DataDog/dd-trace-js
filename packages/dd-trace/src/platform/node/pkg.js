'use strict'

const path = require('path')
const readPkgUp = require('read-pkg-up')

function findRoot () {
  return require.main ? path.dirname(require.main.filename) : process.cwd()
}

function findPkg () {
  const cwd = findRoot()
  const up = readPkgUp.sync({ cwd })

  return up && up.pkg ? up.pkg : {}
}

module.exports = findPkg()
