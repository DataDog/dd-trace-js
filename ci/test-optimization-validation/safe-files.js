'use strict'

const crypto = require('node:crypto')
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
  const resolvedFilename = path.resolve(filename)
  const parent = path.dirname(resolvedFilename)
  ensureSafeDirectory(root, parent, label)
  const parentIdentity = getDirectoryIdentity(parent, label)
  const temporaryFilename = path.join(
    parent,
    `.${path.basename(filename)}.${crypto.randomBytes(12).toString('hex')}.tmp`
  )

  try {
    openAndWrite(root, temporaryFilename, data, label, fs.constants.O_EXCL)
    assertDirectoryIdentity(parent, parentIdentity, label)
    fs.renameSync(temporaryFilename, resolvedFilename)
  } catch (error) {
    removeTemporaryFile(temporaryFilename, parent, parentIdentity)
    throw error
  }
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
    const stat = fs.fstatSync(file)
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Refusing ${label} because its output is not a private regular file: ${resolvedFilename}`)
    }
    fs.writeFileSync(file, data)
  } finally {
    fs.closeSync(file)
  }
}

/**
 * Captures one directory identity without accepting a symbolic link.
 *
 * @param {string} directory directory path
 * @param {string} label customer-facing path label
 * @returns {{dev: number, ino: number}} directory identity
 */
function getDirectoryIdentity (directory, label) {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing ${label} because its parent is not a regular directory: ${directory}`)
  }
  return { dev: stat.dev, ino: stat.ino }
}

/**
 * Refuses replacement of a parent directory between safe creation and publication.
 *
 * @param {string} directory directory path
 * @param {{dev: number, ino: number}} expected expected identity
 * @param {string} label customer-facing path label
 */
function assertDirectoryIdentity (directory, expected, label) {
  const current = getDirectoryIdentity(directory, label)
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`Refusing ${label} because its parent directory changed during the write: ${directory}`)
  }
}

/**
 * Removes only the validator-created temporary regular file or symbolic link.
 *
 * @param {string} filename temporary filename
 * @param {string} parent expected parent directory
 * @param {{dev: number, ino: number}} parentIdentity expected parent identity
 */
function removeTemporaryFile (filename, parent, parentIdentity) {
  try {
    assertDirectoryIdentity(parent, parentIdentity, 'temporary file cleanup')
    const stat = fs.lstatSync(filename)
    if (stat.isFile() || stat.isSymbolicLink()) fs.unlinkSync(filename)
  } catch {}
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
