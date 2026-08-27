'use strict'

const Module = require('node:module')

const loggerNames = new Set(['bunyan', 'pino', 'winston'])
const resolveFilename = Module._resolveFilename

/**
 * @param {string} request
 * @param {{ filename?: string }} [parent]
 * @returns {string}
 */
Module._resolveFilename = function (request, parent) {
  if (loggerNames.has(request) && parent?.filename?.endsWith('esm-mapped-logger-test.mjs')) {
    process.stderr.write(`[unexpected logger resolution] ${request}\n`)
  }
  return resolveFilename.apply(this, arguments)
}
