'use strict'

const assert = require('node:assert/strict')
const Module = require('node:module')

const { describe } = require('mocha')

require('../setup/core')

// OpenTracing's upstream API compatibility checks depend on `chai`, but this
// repo intentionally does not. We provide a minimal shim just for these checks
// (assert.equal, expect(...).to.not.throw(), expect(...).to.be.a()).
function createChaiShim () {
  return {
    assert: { equal: assert.strictEqual },
    expect (value) {
      return {
        to: {
          not: {
            throw: value,
          },
          be: {
            a: (type) => {
              assert.strictEqual(typeof value, type)
            },
          },
        },
      }
    },
  }
}

function loadApiCompatibilityChecks (packageName) {
  // @ts-expect-error - `Module._load` is an internal Node API used only for this test shim.
  const originalLoad = Module._load
  // @ts-expect-error - `Module._load` is an internal Node API used only for this test shim.
  Module._load = function (request, parent, isMain) {
    if (request === 'chai') return createChaiShim()
    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    return require(`${packageName}/lib/test/api_compatibility`).default
  } finally {
    // Restore immediately after loading OpenTracing's test helper.
    // @ts-expect-error - `Module._load` is an internal Node API used only for this test shim.
    Module._load = originalLoad
  }
}

const tracer = require('../..')

describe('OpenTracing API', () => {
  // Keep the older runtime contract covered even though public type identity is pinned to 0.14.7.
  for (const [version, packageName] of [
    ['0.14.0', 'opentracing-0.14.0'],
    ['0.14.7', 'opentracing'],
  ]) {
    describe(version, () => {
      const apiCompatibilityChecks = loadApiCompatibilityChecks(packageName)

      apiCompatibilityChecks(() => tracer.init({
        service: 'test',
        flushInterval: 0,
        plugins: false,
      }))
    })
  }
})
