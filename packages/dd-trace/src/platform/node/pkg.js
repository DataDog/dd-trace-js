'use strict'

const path = require('path')
const readPkgUp = require('read-pkg-up')

function findRoot () {
  return path.dirname(require.main.filename)
}

function findPkg () {
  const cwd = findRoot()
  const up = readPkgUp.sync({ cwd })

  return up && up.pkg ? up.pkg : {}
}

module.exports = findPkg()
