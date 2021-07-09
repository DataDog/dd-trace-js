'use strict'

/* eslint-disable no-console */

const fs = require('fs')
const path = require('path')
const semver = require('semver')

const nodeVersion = process.versions.node

const range = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
).engines.node

if (!semver.satisfies(nodeVersion, range)) {
  process.exitCode = 1
  console.error('\n' + `
You're using Node.js v${process.versions.node}, which is not supported by
dd-trace.

Please upgrade to a more recent version of Node.js.
  `.trim() + '\n')
}
