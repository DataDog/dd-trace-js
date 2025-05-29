'use strict'

/* eslint-disable no-var */

var ddMatches = require('./package.json').version.match(/^(\d+)\.(\d+)\.(\d+)/)
var nodeMatches = process.versions.node.match(/^(\d+)\.(\d+)\.(\d+)/)

module.exports = {
  DD_MAJOR: Number.parseInt(ddMatches[1]),
  DD_MINOR: Number.parseInt(ddMatches[2]),
  DD_PATCH: Number.parseInt(ddMatches[3]),
  NODE_MAJOR: Number.parseInt(nodeMatches[1]),
  NODE_MINOR: Number.parseInt(nodeMatches[2]),
  NODE_PATCH: Number.parseInt(nodeMatches[3])
}
