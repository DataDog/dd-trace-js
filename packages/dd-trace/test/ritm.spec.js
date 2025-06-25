'use strict'

const t = require('tap')
require('./setup/core')

const dc = require('dc-polyfill')
const { assert } = require('chai')
const Module = require('module')
const Hook = require('../src/ritm')

t.test('Ritm', t => {
  let moduleLoadStartChannel, moduleLoadEndChannel, startListener, endListener
  let utilHook, aHook, bHook, httpHook

  t.before(() => {
    moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')
    moduleLoadEndChannel = dc.channel('dd-trace:moduleLoadEnd')
  })

  t.beforeEach(() => {
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

  t.afterEach(() => {
    utilHook.unhook()
    aHook.unhook()
    bHook.unhook()
    httpHook.unhook()
  })

  t.test('should shim util', t => {
    require('util')
    assert.equal(startListener.callCount, 1)
    assert.equal(endListener.callCount, 1)
    t.end()
  })

  t.test('should handle module load cycles', t => {
    const { a } = require('./ritm-tests/module-a')
    assert.equal(startListener.callCount, 2)
    assert.equal(endListener.callCount, 2)
    assert.equal(a(), 'Called by AJ')
    t.end()
  })

  t.test('should allow override original module', t => {
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
    t.end()
  })

  t.test('should fall back to monkey patched module', t => {
    assert.equal(require('http').foo, 1, 'normal hooking still works')

    const fnCore = require('@azure/functions-core')
    assert.ok(fnCore, 'requiring monkey patched in module works')
    assert.equal(fnCore.version, '1.0.0')
    assert.equal(typeof fnCore.registerHook, 'function')

    assert.throws(
      () => require('package-does-not-exist'),
      'Cannot find module \'package-does-not-exist\'',
      'a failing `require(...)` can still throw as expected'
    )
    t.end()
  })
  t.end()
})
