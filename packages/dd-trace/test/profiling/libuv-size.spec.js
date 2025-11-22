'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('tap').mocha

require('../setup/core')

const libuvSize = require('../../src/profiling/libuv-size')

describe('libuv-size', function () {
  describe('getLibuvThreadPoolSize should return', function () {
    it('undefined if no environment variable is set', function () {
      assert.strictEqual(libuvSize.getLibuvThreadPoolSize(), undefined)
    })

    it('0 for an empty environment variable', function () {
      assert.strictEqual(libuvSize.getLibuvThreadPoolSize(''), 0)
    })

    it('0 for an invalid environment variable', function () {
      assert.strictEqual(libuvSize.getLibuvThreadPoolSize('invalid'), 0)
    })

    it('a parsed numeric value', function () {
      assert.strictEqual(libuvSize.getLibuvThreadPoolSize('100'), 100)
    })
  })

  describe('getEffectiveLibuvThreadPoolSize should return', function () {
    it('the libuv thread pool size if set', function () {
      assert.strictEqual(libuvSize.getEffectiveLibuvThreadCount(100), 100)
    })

    it('the default value if not set', function () {
      assert.strictEqual(libuvSize.getEffectiveLibuvThreadCount(), 4)
    })

    it('1 if set to 0', function () {
      assert.strictEqual(libuvSize.getEffectiveLibuvThreadCount(0), 1)
    })

    it('1024 if set to a negative value', function () {
      assert.strictEqual(libuvSize.getEffectiveLibuvThreadCount(-1), 1024)
      assert.strictEqual(libuvSize.getEffectiveLibuvThreadCount(-100000), 1024)
    })

    it('1024 if set to a very large value', function () {
      assert.strictEqual(libuvSize.getEffectiveLibuvThreadCount(1025), 1024)
      assert.strictEqual(libuvSize.getEffectiveLibuvThreadCount(100000), 1024)
    })
  })
})
