'use strict'

const assert = require('node:assert/strict')
const images = require('../assets/images.json')

/** @param {{version: string, engines: {node: string}, nodeMaxMajor: number}} pkg */
function plan (pkg) {
  // Loaded only by the preparation job, after the checkout's dependencies are installed.
  const semver = require('semver')
  const major = semver.major(pkg.version)
  assert.ok([5, 6, 7].includes(major), `Choose a reviewed released control for tracer major ${major}`)
  const node = Object.keys(images).filter(runtime =>
    semver.intersects(`${runtime}.x`, pkg.engines.node) && Number(runtime) <= pkg.nodeMaxMajor)
  assert.ok(node.length, 'No compatible Lambda runtimes; update the pinned image inventory')
  return { node }
}

module.exports = { plan }
if (require.main === module) console.log(JSON.stringify(plan(require('../../../package.json'))))
