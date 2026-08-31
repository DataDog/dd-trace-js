'use strict'

/** @typedef {NonNullable<ReturnType<string['match']>>} RegExpMatch */

var version = require('./package.json').version
// @ts-expect-error
var /** @type {RegExpMatch} */ ddMatches = version.match(/^(\d+)\.(\d+)\.(\d+)/)
// @ts-expect-error
var /** @type {RegExpMatch} */ nodeMatches = process.versions.node.match(/^(\d+)\.(\d+)\.(\d+)/)

module.exports = {
  VERSION: version,
  DD_MAJOR: parseInt(ddMatches[1], 10),
  DD_MINOR: parseInt(ddMatches[2], 10),
  DD_PATCH: parseInt(ddMatches[3], 10),
  NODE_MAJOR: parseInt(nodeMatches[1], 10),
  NODE_MINOR: parseInt(nodeMatches[2], 10),
  NODE_PATCH: parseInt(nodeMatches[3], 10),
  NODE_VERSION: nodeMatches[0]
}
