'use strict'

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
  let utilHook, aHook, bHook, httpHook, relativeHook

  before(() => {
    moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')
    moduleLoadEndChannel = dc.channel('dd-trace:moduleLoadEnd')
  })

  beforeEach(() => {
    startListener = sinon.fake()
    endListener = sinon.fake()

    moduleLoadStartChannel.subscribe(startListener)
    moduleLoadEndChannel.subscribe(endListener)

    Module.prototype.require = new Proxy(Module.prototype.require, {
      apply (target, thisArg, argArray) {
        if (argArray[0] === monkeyPatchedModuleName) {
          return {
            version: '1.0.0',
            registerHook: () => { }
          }
        } else {
          return Reflect.apply(target, thisArg, argArray)
        }
      }
    })

    utilHook = Hook('util')
    aHook = Hook('module-a')
    bHook = Hook('module-b')
    httpHook = new Hook(['http'], function onRequire (exports, name, basedir) {
      exports.foo = 1
      return exports
    })
    relativeHook = new Hook(['./ritm-tests/relative/module-c'], function onRequire (exports) {
      exports.foo = 1
      return exports
    })
  })

  afterEach(() => {
    utilHook.unhook()
    aHook.unhook()
    bHook.unhook()
    httpHook.unhook()
    relativeHook.unhook()
  })

  it('should shim util', () => {
    assert.equal(startListener.callCount, 0)
    assert.equal(endListener.callCount, 0)
    require('util')
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
    const http = /** @type {{ foo?: number }} */ (require('http'))
    assert.equal(http.foo, 1, 'normal hooking still works')

    const monkeyPatchedModule = require(monkeyPatchedModuleName)
    assert.ok(monkeyPatchedModule, 'requiring monkey patched module works')
    assert.equal(monkeyPatchedModule.version, '1.0.0')
    assert.equal(typeof monkeyPatchedModule.registerHook, 'function')

    assert.throws(
      () => require(missingModuleName),
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
