'use strict'

/* eslint-disable no-console */

const path = require('path')
const requirePackageJson = require('../packages/dd-trace/src/require-package-json.js')

const nodeMajor = Number(process.versions.node.split('.')[0])

const min = Number(requirePackageJson(path.join(__dirname, '..')).engines.node.match(/\d+/)[0])

if (nodeMajor < min) {
  process.exitCode = 1
  console.error('\n' + `
You're using Node.js v${process.versions.node}, which is not supported by
dd-trace.

Please upgrade to a more recent version of Node.js.
  `.trim() + '\n')
}
