'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * Creates a directory while refusing symlink components and paths outside the allowed root.
 *
 * @param {string} root allowed root
 * @param {string} directory directory to create or validate
 * @param {string} label customer-facing path label
 * @param {{allowRootSymlink?: boolean}} [options] validation options
 */
function ensureSafeDirectory (root, directory, label, options = {}) {
  const lexicalRoot = path.resolve(root)
  const resolvedDirectory = path.resolve(directory)
  const rootStat = fs.lstatSync(lexicalRoot)
  if (rootStat.isSymbolicLink() && !options.allowRootSymlink) {
    throw new Error(`Refusing ${label} because its allowed root is a symbolic link: ${lexicalRoot}`)
  }
  if (!rootStat.isDirectory() && !rootStat.isSymbolicLink()) {
    throw new Error(`Refusing ${label} because its allowed root is not a directory: ${lexicalRoot}`)
  }
  if (!isPathInside(lexicalRoot, resolvedDirectory)) {
    throw new Error(`Refusing ${label} outside allowed root: ${resolvedDirectory}`)
  }

  let current = lexicalRoot
  const relative = path.relative(lexicalRoot, resolvedDirectory)
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment)
    let stat
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      fs.mkdirSync(current)
      stat = fs.lstatSync(current)
    }

    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing ${label} through symbolic link: ${current}`)
    }
    if (!stat.isDirectory()) {
      throw new Error(`Refusing ${label} through non-directory path: ${current}`)
    }
  }

  const physicalRoot = fs.realpathSync(lexicalRoot)
  const physicalDirectory = fs.realpathSync(resolvedDirectory)
  if (!isPathInside(physicalRoot, physicalDirectory)) {
    throw new Error(`Refusing ${label} outside physical allowed root: ${resolvedDirectory}`)
  }
}

/**
 * Writes a regular file without following a symbolic-link target.
 *
 * @param {string} root allowed root
 * @param {string} filename output filename
 * @param {string|Buffer} data output data
 * @param {string} label customer-facing path label
 */
function writeFileSafely (root, filename, data, label) {
  openAndWrite(root, filename, data, label, fs.constants.O_TRUNC)
}

/**
 * Creates a new regular file without following or replacing an existing path.
 *
 * @param {string} root allowed root
 * @param {string} filename output filename
 * @param {string|Buffer} data output data
 * @param {string} label customer-facing path label
 */
function createFileSafely (root, filename, data, label) {
  openAndWrite(root, filename, data, label, fs.constants.O_EXCL)
}

/**
 * Opens and writes a file with no-follow semantics.
 *
 * @param {string} root allowed root
 * @param {string} filename output filename
 * @param {string|Buffer} data output data
 * @param {string} label customer-facing path label
 * @param {number} creationFlag file creation mode
 */
function openAndWrite (root, filename, data, label, creationFlag) {
  const resolvedFilename = path.resolve(filename)
  ensureSafeDirectory(root, path.dirname(resolvedFilename), label)
  refuseSymbolicLink(resolvedFilename, label)

  const flags = fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    creationFlag |
    (fs.constants.O_NOFOLLOW || 0)
  const file = fs.openSync(resolvedFilename, flags, 0o600)
  try {
    fs.writeFileSync(file, data)
  } finally {
    fs.closeSync(file)
  }
}

/**
 * Refuses a final path component that is a symbolic link.
 *
 * @param {string} filename candidate filename
 * @param {string} label customer-facing path label
 */
function refuseSymbolicLink (filename, label) {
  try {
    if (fs.lstatSync(filename).isSymbolicLink()) {
      throw new Error(`Refusing ${label} symbolic-link target: ${filename}`)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

/**
 * Checks lexical path containment.
 *
 * @param {string} root allowed root
 * @param {string} filename candidate path
 * @returns {boolean} true when the candidate is inside the root
 */
function isPathInside (root, filename) {
  const relative = path.relative(root, filename)
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

module.exports = {
  createFileSafely,
  ensureSafeDirectory,
  writeFileSafely,
}
