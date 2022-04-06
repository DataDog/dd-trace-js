'use strict'

const fs = require('fs')
const path = require('path')

function findRoot () {
  return require.main && require.main.filename
    ? path.dirname(require.main.filename)
    : process.cwd()
}

function findPkg () {
  const cwd = findRoot()
  const directory = path.resolve(cwd)
  const res = path.parse(directory)

  if (!res) return {}

  const { root } = res

  const filePath = findUp('package.json', root, directory)

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (e) {
    return {}
  }
}

function findUp (name, root, directory) {
  while (true) {
    const current = path.resolve(directory, name)

    if (fs.existsSync(current)) return current

    if (directory === root) return

    directory = path.dirname(directory)
  }
}

module.exports = Object.assign(findPkg(), { findRoot, findUp })
