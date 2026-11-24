'use strict'

const fs = require('node:fs')

const readFileSync = fs.readFileSync

/**
 * @param {Parameters<typeof readFileSync>[0]} filePath
 * @param {Parameters<typeof readFileSync>[1]} [options]
 */
fs.readFileSync = function (filePath, options) {
  if (String(filePath).endsWith('/target-patterns.json')) return '{}\n'
  return readFileSync(filePath, options)
}
