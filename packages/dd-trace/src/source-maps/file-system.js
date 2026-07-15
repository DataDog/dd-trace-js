'use strict'

/**
 * @typedef {object} DirectFileSystem
 * @property {typeof import('node:fs').closeSync} closeSync
 * @property {typeof import('node:fs').fstatSync} fstatSync
 * @property {typeof import('node:fs').openSync} openSync
 * @property {typeof import('node:fs').readFileSync} readFileSync
 * @property {typeof import('node:fs').readSync} readSync
 * @property {typeof import('node:fs').statSync} statSync
 */

/**
 * Capture core filesystem functions before instrumentation can replace the module exports.
 *
 * @returns {DirectFileSystem}
 */
function captureFileSystem () {
  const fs = require('node:fs')
  return {
    closeSync: fs.closeSync,
    fstatSync: fs.fstatSync,
    openSync: fs.openSync,
    readFileSync: fs.readFileSync,
    readSync: fs.readSync,
    statSync: fs.statSync,
  }
}

module.exports = captureFileSystem
