'use strict'

var version = require('./package.json').version
var runtime = require('./packages/dd-trace/src/utils/runtime')

// @ts-expect-error
var /** @type {RegExpMatchArray} */ ddMatches =
    version.match(/^(\d+)\.(\d+)\.(\d+)/)
// @ts-expect-error
var /** @type {RegExpMatchArray} */ nodeMatches =
  process.versions.node.match(/^(\d+)\.(\d+)\.(\d+)/)
// @ts-expect-error
var /** @type {RegExpMatchArray} */ runtimeVersion = runtime.runtimeVersion.match(/^(\d+)\.(\d+)\.(\d+)/)

module.exports = {
  VERSION: version,
  DD_MAJOR: parseInt(ddMatches[1]),
  DD_MINOR: parseInt(ddMatches[2]),
  DD_PATCH: parseInt(ddMatches[3]),
  NODE_MAJOR: parseInt(nodeMatches[1]),
  NODE_MINOR: parseInt(nodeMatches[2]),
  NODE_PATCH: parseInt(nodeMatches[3]),
  NODE_VERSION: nodeMatches[0],
  RUNTIME: runtime.runtimeName,
  RUNTIME_MAJOR: parseInt(runtimeVersion[1]), // in case it breaks downstream consumer
  RUNTIME_MINOR: parseInt(runtimeVersion[2]),
  RUNTIME_PATCH: parseInt(runtimeVersion[3]),
  RUNTIME_VERSION: runtime.runtimeVersion
}
