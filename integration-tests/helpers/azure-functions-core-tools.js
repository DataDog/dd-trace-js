'use strict'

const { dirname, join } = require('node:path')

const executable = process.platform === 'win32' ? 'func.exe' : 'func'

function getFuncPath () {
  const { pkgJsonPath } = require('../../versions/azure-functions-core-tools')
  return join(dirname(pkgJsonPath()), 'bin', executable)
}

module.exports = { getFuncPath }
