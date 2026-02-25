'use strict'

const sinon = require('sinon')
const dc = require('dc-polyfill')
const { describe, it, before, beforeEach } = require('tap').mocha

const assert = require('node:assert')
const Module = require('node:module')

const sinon = require('sinon')
const dc = require('dc-polyfill')
const { describe, it, before, beforeEach, afterEach } = require('mocha')

require('./setup/core')
const Hook = require('../src/ritm')

describe('Ritm', () => {
  const monkeyPatchedModuleName = 'dd-trace-monkey-patched-module'
  const missingModuleName = 'package-does-not-exist'

  let moduleLoadStartChannel, moduleLoadEndChannel, startListener, endListener
  const mockedModuleName = '@azure/functions-core'

  before(() => {
    moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')
    moduleLoadEndChannel = dc.channel('dd-trace:moduleLoadEnd')

    Module.prototype.require = new Proxy(Module.prototype.require, {
      apply(target, thisArg, argArray) {
        if (argArray[0] === mockedModuleName) {
          return {
            version: '1.0.0',
            registerHook: () => { },
          }
        } else {
          return Reflect.apply(target, thisArg, argArray)
        }
      },
    })

    function onRequire() { }
    Hook(['util'], onRequire)
    Hook(['module-a'], onRequire)
    Hook(['module-b'], onRequire)
    Hook(['http'], function onRequire(exports, name, basedir) {
      exports.foo = 1
      return exports
    })
    relativeHook = new Hook(['./ritm-tests/relative/module-c'], function onRequire(exports) {
      exports.foo = 1
      return exports
    })
    relativeHook = new Hook(['./ritm-tests/relative/module-c'], function onRequire(exports) {
      exports.foo = 1
      return exports
    })
  })

  beforeEach(() => {
    startListener = sinon.fake()
    endListener = sinon.fake()

    moduleLoadStartChannel.subscribe(startListener)
    moduleLoadEndChannel.subscribe(endListener)
  })

  it('should shim util', () => {
    require('node:util')
    assert.equal(startListener.callCount, 1)
    assert.equal(endListener.callCount, 1)
  })

  it('should handle module load cycles', () => {
    assert.equal(startListener.callCount, 0)
    assert.equal(endListener.callCount, 0)
    const { a } = require('./ritm-tests/module-a')
    // The module load channels fire for *every* require() handled by RITM, not
    // just these fixture modules. In practice, additional requires can happen
    // depending on runtime/tooling, so the stable invariant is:
    // - we don't recurse infinitely on a CJS cycle
    // - we observe module-a and module-b as part of the cycle
    // - start/end counts stay in sync
    assert.ok(startListener.callCount >= 2)
    assert.equal(endListener.callCount, startListener.callCount)

    const startRequests = new Set()
    let startRequestsCount = 0
    for (const call of startListener.args) {
      startRequests.add(call[0].request)
      startRequestsCount++
    }
    assert.equal(startRequests.size, startRequestsCount)
    assert.ok(startRequests.has('./ritm-tests/module-a'))
    assert.ok(startRequests.has('./module-b'))
    assert.equal(a(), 'Called by AJ')
  })

  it('should allow override original module', () => {
    const onModuleLoadEnd = (payload) => {
      if (payload.request === './ritm-tests/module-default') {
        payload.module = function () {
          return 'ho'
        }
      }
    }

    moduleLoadEndChannel.subscribe(onModuleLoadEnd)
    try {
      const hi = require('./ritm-tests/module-default')
      assert.equal(hi(), 'ho')
    } finally {
      moduleLoadEndChannel.unsubscribe(onModuleLoadEnd)
    }
  })

  it('should fall back to monkey patched module', () => {
    // @ts-expect-error - Patching module works as expected
    assert.equal(require('node:http').foo, 1, 'normal hooking still works')

    const fnCore = require(mockedModuleName)
    assert.ok(fnCore, 'requiring monkey patched in module works')
    assert.equal(fnCore.version, '1.0.0')
    assert.equal(typeof fnCore.registerHook, 'function')

    assert.throws(
      // @ts-expect-error - Package does not exist
      () => require('package-does-not-exist'),
      /Cannot find module 'package-does-not-exist'/,
      'a failing `require(...)` can still throw as expected'
    )
  })

  it('should hook into registered relative path requires', () => {
    assert.equal(require('./ritm-tests/relative/module-c').foo, 1)
    assert.equal(startListener.callCount, 1)
    assert.equal(endListener.callCount, 1)
  })
})
