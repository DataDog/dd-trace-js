'use strict'

const semver = require('semver')

if (semver.satisfies(process.versions.node, '^12.20.0 || >=14.13.1')) {
  module.exports = require('import-in-the-middle')
} else {
  // ESM not properly supported by this version of node.js
  module.exports = () => {}
}
