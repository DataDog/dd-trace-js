'use strict'

var NODE_MAJOR = require('../../../../version').NODE_MAJOR
var pkg = require('../../../../package.json')
var isTrue = require('./util').isTrue

var minMajor = pkg.engines.node.match(/^>=(\d+)$/)[1]
var nextMajor = pkg.nodeMaxMajor
var incompatibleRuntime = NODE_MAJOR < minMajor || NODE_MAJOR >= nextMajor
var forced = isTrue(process.env.DD_INJECT_FORCE)

module.exports = {
  abortsInstrumentation: incompatibleRuntime && !forced,
  forced: forced,
  incompatibleRuntime: incompatibleRuntime,
  supportedRange: pkg.engines.node + ' <' + nextMajor
}
