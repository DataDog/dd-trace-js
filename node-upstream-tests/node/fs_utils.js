'use strict'

const fs = require('fs')
const path = require('path')
const promisify = require('util').promisify

const glob = promisify(require('glob'))
const readFile = promisify(fs.readFile)
const access = promisify(fs.access)
const stat = promisify(fs.stat)

async function pathExists (path) {
  try {
    await access(path)
    return true
  } catch (e) {
    if (e.code === 'ENOENT') {
      return false
    }
    throw e
  }
}

async function samePath (path, other) {
  const pathStat = await stat(path)
  const otherStat = await stat(other)
  return pathStat.ino === otherStat.ino
}

function parentDir (p, depth = 1) {
  let parentPath = p
  for (let i = 0; i < depth; i++) {
    parentPath = path.dirname(parentPath)
  }
  return parentPath
}

function parentName (p, depth = 1) {
  return path.basename(parentDir(p, depth))
}

module.exports = {
  glob,
  parentDir,
  parentName,
  pathExists,
  readFile,
  samePath
}
