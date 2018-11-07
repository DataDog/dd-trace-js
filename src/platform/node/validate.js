'use strict'

const semver = require('semver')

const SUPPORTED_VERSIONS = '^4.7 || ^6.9 || >=8'

function validate () {
  if (!semver.satisfies(process.versions.node, SUPPORTED_VERSIONS)) {
    throw new Error([
      `Node ${process.versions.node} is not supported.`,
      `Only versions of Node matching "${SUPPORTED_VERSIONS}" are supported.`,
      `Tracing has been disabled.`
    ].join(' '))
  }
}

module.exports = validate
