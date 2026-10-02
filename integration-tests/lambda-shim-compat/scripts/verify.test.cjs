'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')

const verifierPath = path.join(__dirname, '../assets/fixture/verify.cjs')
const verifierSource = fs.readFileSync(verifierPath, 'utf8')
const runtimeMajor = Number(process.versions.node.split('.')[0])

/**
 * Runs the installed-artifact verifier with package metadata supplied in memory.
 * @param {number} major Tracer release line.
 * @param {number} nodeMaxMajor First unsupported Node major.
 */
function verify (major, nodeMaxMajor) {
  const tracer = { name: 'dd-trace', version: `${major}.0.0`, engines: { node: '>=18' }, nodeMaxMajor }
  const shim = {
    name: 'datadog-lambda-js',
    version: '12.143.0',
    engines: { node: '>=18' },
    peerDependencies: { 'dd-trace': '>=5 <8' },
  }
  const packages = new Map([
    ['/var/task/node_modules/dd-trace/package.json', tracer],
    ['/var/task/node_modules/datadog-lambda-js/package.json', shim],
  ])
  const output = []
  vm.runInNewContext(verifierSource, {
    require (name) {
      if (name === './metadata.json') return { version: tracer.version, shimVersion: shim.version, sourceHashes: {} }
      if (name === 'node:module') return { createRequire: () => require }
      if (name === 'node:fs') {
        return {
          realpathSync: file => file,
          readFileSync (file) {
            assert.ok(packages.has(file), `Unexpected fixture read: ${file}`)
            return JSON.stringify(packages.get(file))
          },
        }
      }
      return require(name)
    },
    process: {
      env: {},
      version: process.version,
      versions: process.versions,
      execPath: process.execPath,
      arch: process.arch,
    },
    console: { log: value => output.push(JSON.parse(value)) },
  }, { filename: verifierPath })
  assert.equal(output.length, 1)
  return output[0]
}

for (const major of [5, 6, 7]) {
  test(`v${major} installed-artifact verification rejects runtimes at or above nodeMaxMajor`, () => {
    assert.equal(verify(major, runtimeMajor + 1).verified, true)
    assert.throws(() => verify(major, runtimeMajor), /Runtime must be below dd-trace nodeMaxMajor=/)
    assert.throws(() => verify(major, runtimeMajor - 1), /Runtime must be below dd-trace nodeMaxMajor=/)
  })
}
