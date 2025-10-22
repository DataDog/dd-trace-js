'use strict'

var version = require('./package.json').version
// @ts-expect-error
var /** @type {RegExpMatchArray} */ ddMatches = version.match(/^(\d+)\.(\d+)\.(\d+)/)
// @ts-expect-error
var /** @type {RegExpMatchArray} */ nodeMatches = process.versions.node.match(/^(\d+)\.(\d+)\.(\d+)/)

module.exports = {
  VERSION: version,
  DD_MAJOR: parseInt(ddMatches[1]),
  DD_MINOR: parseInt(ddMatches[2]),
  DD_PATCH: parseInt(ddMatches[3]),
  NODE_MAJOR: parseInt(nodeMatches[1]),
  NODE_MINOR: parseInt(nodeMatches[2]),
  NODE_PATCH: parseInt(nodeMatches[3]),
  NODE_VERSION: nodeMatches[0],
  IS_NIGHTLY: nodeMatches[0] >= 25
}
