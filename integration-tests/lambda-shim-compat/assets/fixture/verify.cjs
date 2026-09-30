'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

const mode = process.env.COMPAT_MODE
const root = mode === 'layer-only' ? '/opt/nodejs/node_modules' : '/var/task/node_modules'
const metadata = require('./metadata.json')
const tracerPackage = path.join(root, 'dd-trace/package.json')
const tracer = JSON.parse(fs.readFileSync(tracerPackage, 'utf8'))
const shim = JSON.parse(fs.readFileSync(path.join(root, 'datadog-lambda-js/package.json'), 'utf8'))
// Use the Node image's npm dependency, not an assumed dependency of the tracer under test.
const npmEntry = fs.realpathSync(path.join(path.dirname(process.execPath), 'npm'))
const npmRequire = createRequire(npmEntry)
const semver = npmRequire('semver')
assert.equal(tracer.version, metadata.version, 'Wrong installed tracer artifact')
if (metadata.enginesNode) assert.equal(tracer.engines.node, metadata.enginesNode, 'Candidate engine range was modified')
assert.equal(shim.version, metadata.shimVersion, 'Wrong installed shim artifact')
for (const pkg of [tracer, shim]) {
  assert.ok(semver.satisfies(process.version, pkg.engines.node),
    `${pkg.name}@${pkg.version} requires ${pkg.engines.node}; runtime is ${process.version}`)
}
if (tracer.nodeMaxMajor !== undefined) {
  assert.ok(Number(process.versions.node.split('.')[0]) <= Number(tracer.nodeMaxMajor),
    `Runtime exceeds dd-trace nodeMaxMajor=${tracer.nodeMaxMajor}`)
}
for (const [file, expected] of Object.entries(metadata.sourceHashes)) {
  const bytes = fs.readFileSync(path.join(root, 'dd-trace', file))
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected,
    `Installed candidate source differs from packed checkout: ${file}`)
}
console.log(JSON.stringify({
  verified: true,
  runtime: process.version,
  architecture: process.arch,
  tracerVersion: tracer.version,
  shimVersion: shim.version,
  sourceFiles: Object.keys(metadata.sourceHashes).length,
  peerCompatible: semver.satisfies(tracer.version, shim.peerDependencies['dd-trace']),
}))
