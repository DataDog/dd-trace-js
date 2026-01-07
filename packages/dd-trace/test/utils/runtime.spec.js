'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('tap').mocha

require('../setup/core')

describe('runtime detection', () => {
  let originalIsBun
  let originalVersions
  const runtimeModulePath = require.resolve('../../src/utils/runtime')

  beforeEach(() => {
    // save original process properties
    originalIsBun = process.isBun
    originalVersions = { ...process.versions }
    // clear module cache to allow fresh requires
    delete require.cache[runtimeModulePath]
  })

  afterEach(() => {
    // restore original process properties
    if (originalIsBun === undefined) {
      delete process.isBun
    } else {
      process.isBun = originalIsBun
    }
    // restore versions by restoring original values
    // only restore properties that were in the original, don't delete others
    // this is safer and won't break the module system
    for (const key in originalVersions) {
      try {
        Object.defineProperty(process.versions, key, {
          value: originalVersions[key],
          writable: true,
          enumerable: true,
          configurable: true
        })
      } catch (e) {
        // if we can't define, try direct assignment
        try {
          process.versions[key] = originalVersions[key]
        } catch (e2) {
          // ignore if we can't restore
        }
      }
    }
    // clear module cache after test
    delete require.cache[runtimeModulePath]
  })

  function setVersions (versions) {
    // only override/add specific version properties, don't delete existing ones
    // this prevents breaking the module system
    for (const key in versions) {
      try {
        Object.defineProperty(process.versions, key, {
          value: versions[key],
          writable: true,
          enumerable: true,
          configurable: true
        })
      } catch (e) {
        // if we can't define the property, try direct assignment
        process.versions[key] = versions[key]
      }
    }
  }

  function removeVersionProperty (key) {
    // safely remove a version property if it exists
    if (key in process.versions) {
      try {
        delete process.versions[key]
      } catch (e) {
        // ignore if we can't delete
      }
    }
  }

  it('detects Bun when process.isBun is true', () => {
    // mock bun process
    process.isBun = true
    setVersions({ bun: '1.0.0' })

    const runtimeModule = require('../../src/utils/runtime')

    assert.strictEqual(runtimeModule.runtimeName, 'bun')
    assert.strictEqual(runtimeModule.runtimeVersion, '1.0.0')
    assert.strictEqual(runtimeModule.isBun, true)
    assert.strictEqual(runtimeModule.isNode, false)
    assert.deepStrictEqual(runtimeModule.runtime, {
      name: 'bun',
      version: '1.0.0',
      isBun: true,
      isNode: false
    })
  })

  it('detects Bun with unknown version when process.versions.bun is missing', () => {
    // mock bun process without version
    process.isBun = true
    // remove bun version if it exists, but keep other versions intact
    removeVersionProperty('bun')

    const runtimeModule = require('../../src/utils/runtime')

    assert.strictEqual(runtimeModule.runtimeName, 'bun')
    assert.strictEqual(runtimeModule.runtimeVersion, 'unknown')
    assert.strictEqual(runtimeModule.isBun, true)
    assert.strictEqual(runtimeModule.isNode, false)
    assert.deepStrictEqual(runtimeModule.runtime, {
      name: 'bun',
      version: 'unknown',
      isBun: true,
      isNode: false
    })
  })

  it('detects Bun when process.versions.bun is missing (simulating undefined versions)', () => {
    // mock bun process - test that it handles missing versions.bun gracefully
    process.isBun = true
    // remove bun version if it exists
    removeVersionProperty('bun')
    // also remove node to ensure we're testing the bun path
    removeVersionProperty('node')

    const runtimeModule = require('../../src/utils/runtime')

    assert.strictEqual(runtimeModule.runtimeName, 'bun')
    assert.strictEqual(runtimeModule.runtimeVersion, 'unknown')
    assert.strictEqual(runtimeModule.isBun, true)
    assert.strictEqual(runtimeModule.isNode, false)
  })

  it('detects Node.js when process.versions.node exists', () => {
    // mock node process
    delete process.isBun
    // ensure node version exists (it should already, but override to be sure)
    setVersions({ node: '18.0.0' })
    // remove bun version if it exists
    removeVersionProperty('bun')

    const runtimeModule = require('../../src/utils/runtime')

    assert.strictEqual(runtimeModule.runtimeName, 'node')
    assert.strictEqual(runtimeModule.runtimeVersion, '18.0.0')
    assert.strictEqual(runtimeModule.isBun, false)
    assert.strictEqual(runtimeModule.isNode, true)
    assert.deepStrictEqual(runtimeModule.runtime, {
      name: 'node',
      version: '18.0.0',
      isBun: false,
      isNode: true
    })
  })

  it('detects Node.js even when process.isBun is false', () => {
    // mock node process with explicit isBun: false
    process.isBun = false
    setVersions({ node: '20.0.0' })
    removeVersionProperty('bun')

    const runtimeModule = require('../../src/utils/runtime')

    assert.strictEqual(runtimeModule.runtimeName, 'node')
    assert.strictEqual(runtimeModule.runtimeVersion, '20.0.0')
    assert.strictEqual(runtimeModule.isBun, false)
    assert.strictEqual(runtimeModule.isNode, true)
  })

  it('prioritizes Bun detection over Node.js when both are present', () => {
    // mock process with both bun and node indicators (bun should win)
    process.isBun = true
    setVersions({ bun: '1.0.0', node: '18.0.0' })

    const runtimeModule = require('../../src/utils/runtime')

    assert.strictEqual(runtimeModule.runtimeName, 'bun')
    assert.strictEqual(runtimeModule.runtimeVersion, '1.0.0')
    assert.strictEqual(runtimeModule.isBun, true)
    assert.strictEqual(runtimeModule.isNode, false)
  })

  it('falls back to unknown when process.versions.node is missing and process.isBun is not true', () => {
    // mock process without node version and without bun flag
    delete process.isBun
    // remove both node and bun versions, but keep other versions intact
    removeVersionProperty('node')
    removeVersionProperty('bun')

    const runtimeModule = require('../../src/utils/runtime')

    assert.strictEqual(runtimeModule.runtimeName, 'unknown')
    assert.strictEqual(runtimeModule.runtimeVersion, 'unknown')
    assert.strictEqual(runtimeModule.isBun, false)
    assert.strictEqual(runtimeModule.isNode, false)
  })

  it('detects Node.js when process.isBun is undefined (not explicitly true)', () => {
    // mock process with isBun undefined (not true)
    delete process.isBun
    setVersions({ node: '18.0.0' })
    removeVersionProperty('bun')

    const runtimeModule = require('../../src/utils/runtime')

    // should detect as node, not unknown
    assert.strictEqual(runtimeModule.runtimeName, 'node')
    assert.strictEqual(runtimeModule.isBun, false)
    assert.strictEqual(runtimeModule.isNode, true)
  })

  it('does not detect Bun when process.isBun is falsy but not true', () => {
    // mock process with isBun set to false (not true)
    process.isBun = false
    setVersions({ node: '18.0.0' })
    removeVersionProperty('bun')

    const runtimeModule = require('../../src/utils/runtime')

    // should detect as node, not bun
    assert.strictEqual(runtimeModule.runtimeName, 'node')
    assert.strictEqual(runtimeModule.isBun, false)
    assert.strictEqual(runtimeModule.isNode, true)
  })
})
