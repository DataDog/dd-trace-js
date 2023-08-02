'use strict'

const ddVersion = require('./package.json').version
const ddMatches = ddVersion.match(/^(\d+)\.(\d+)\.(\d+)/)
const nodeVersion = process.versions.node
const nodeMatches = nodeVersion.match(/^(\d+)\.(\d+)\.(\d+)/)

module.exports = {
  DD_MAJOR: parseInt(ddMatches[1]),
  DD_MINOR: parseInt(ddMatches[2]),
  DD_PATCH: parseInt(ddMatches[3]),
  DD_FULL: ddVersion,
  NODE_MAJOR: parseInt(nodeMatches[1]),
  NODE_MINOR: parseInt(nodeMatches[2]),
  NODE_PATCH: parseInt(nodeMatches[3]),
  NODE_FULL: nodeVersion
}
