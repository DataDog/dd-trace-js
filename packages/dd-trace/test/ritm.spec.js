'use strict'

require('./setup/tap')

const dc = require('dc-polyfill')
const { assert } = require('chai')
const Module = require('module')
const Hook = require('../src/ritm')

const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')
const moduleLoadEndChannel = dc.channel('dd-trace:moduleLoadEnd')

describe('Ritm', () => {
  it('should shim util', () => {
    const startListener = sinon.fake()
    const endListener = sinon.fake()

    moduleLoadStartChannel.subscribe(startListener)
    moduleLoadEndChannel.subscribe(endListener)
    Hook('util')
    require('util')

    assert.equal(startListener.callCount, 1)
    assert.equal(endListener.callCount, 1)
  })

  it('should handle module load cycles', () => {
    const startListener = sinon.fake()
    const endListener = sinon.fake()

    moduleLoadStartChannel.subscribe(startListener)
    moduleLoadEndChannel.subscribe(endListener)
    Hook('module-a')
    Hook('module-b')
    const { a } = require('./ritm-tests/module-a')

    assert.equal(startListener.callCount, 2)
    assert.equal(endListener.callCount, 2)
    assert.equal(a(), 'Called by AJ')
  })

  it('should fall back to monkey patched module', () => {
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

    const httpHook = new Hook(['http'], function onRequire (exports, name, basedir) {
      exports.foo = 1
      return exports
    })
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

    httpHook.unhook()
  })
})
