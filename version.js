'use strict'

var version = require('./package.json').version
var ddMatches = version.match(/^(\d+)\.(\d+)\.(\d+)/)
var nodeMatches = process.versions.node.match(/^(\d+)\.(\d+)\.(\d+)/)

module.exports = {
  VERSION: version,
  DD_MAJOR: parseInt(ddMatches[1]),
  DD_MINOR: parseInt(ddMatches[2]),
  DD_PATCH: parseInt(ddMatches[3]),
  NODE_MAJOR: parseInt(nodeMatches[1]),
  NODE_MINOR: parseInt(nodeMatches[2]),
  NODE_PATCH: parseInt(nodeMatches[3])
}
