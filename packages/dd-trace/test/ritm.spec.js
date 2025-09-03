'use strict'

const sinon = require('sinon')
const dc = require('dc-polyfill')
const assert = require('node:assert')
const Module = require('node:module')

require('./setup/tap')
const { describe, it, before, beforeEach, afterEach } = require('tap').mocha

const Hook = require('../src/ritm')

describe('Ritm', () => {
  let moduleLoadStartChannel, moduleLoadEndChannel, startListener, endListener
  let utilHook, aHook, bHook, httpHook

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
        if (argArray[0] === '@azure/functions-core') {
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
  })

  afterEach(() => {
    utilHook.unhook()
    aHook.unhook()
    bHook.unhook()
    httpHook.unhook()
  })

  it('should shim util', () => {
    require('util')
    assert.equal(startListener.callCount, 1)
    assert.equal(endListener.callCount, 1)
  })

  it('should handle module load cycles', () => {
    const { a } = require('./ritm-tests/module-a')
    assert.equal(startListener.callCount, 2)
    assert.equal(endListener.callCount, 2)
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
    assert.equal(require('http').foo, 1, 'normal hooking still works')

    const fnCore = require('@azure/functions-core')
    assert.ok(fnCore, 'requiring monkey patched in module works')
    assert.equal(fnCore.version, '1.0.0')
    assert.equal(typeof fnCore.registerHook, 'function')

    assert.throws(
      () => require('package-does-not-exist'),
      /Cannot find module 'package-does-not-exist'/,
      'a failing `require(...)` can still throw as expected'
    )
  })
})
