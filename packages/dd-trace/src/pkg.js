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
  const filePath = findUp('package.json', cwd)

  try {
    return readPkg(path.dirname(filePath))
  } catch (e) {
    return {}
  }
}

function readPkg (cwd) {
  const filePath = path.resolve(cwd, 'package.json')
  const json = JSON.parse(fs.readFileSync(filePath, 'utf8'))

  return json
}

function findUp (name, cwd) {
  let directory = path.resolve(cwd)
  const { root } = path.parse(directory)

  while (true) {
    const current = path.resolve(directory, name)

    if (fs.existsSync(current)) return current
    if (directory === root) return

    directory = path.dirname(directory)
  }
}

module.exports = findPkg()
