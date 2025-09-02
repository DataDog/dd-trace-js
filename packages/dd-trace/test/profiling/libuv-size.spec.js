'use strict'

const { expect } = require('chai')
const { describe, it } = require('tap').mocha

require('../setup/tap')

const libuvSize = require('../../src/profiling/libuv-size')

describe('libuv-size', function () {
  describe('getLibuvThreadPoolSize should return', function () {
    it('undefined if no environment variable is set', function () {
      expect(libuvSize.getLibuvThreadPoolSize()).to.equal(undefined)
    })

    it('0 for an empty environment variable', function () {
      expect(libuvSize.getLibuvThreadPoolSize('')).to.equal(0)
    })

    it('0 for an invalid environment variable', function () {
      expect(libuvSize.getLibuvThreadPoolSize('invalid')).to.equal(0)
    })

    it('a parsed numeric value', function () {
      expect(libuvSize.getLibuvThreadPoolSize('100')).to.equal(100)
    })
  })

  describe('getEffectiveLibuvThreadPoolSize should return', function () {
    it('the libuv thread pool size if set', function () {
      expect(libuvSize.getEffectiveLibuvThreadCount(100)).to.equal(100)
    })

    it('the default value if not set', function () {
      expect(libuvSize.getEffectiveLibuvThreadCount()).to.equal(4)
    })

    it('1 if set to 0', function () {
      expect(libuvSize.getEffectiveLibuvThreadCount(0)).to.equal(1)
    })

    it('1024 if set to a negative value', function () {
      expect(libuvSize.getEffectiveLibuvThreadCount(-1)).to.equal(1024)
      expect(libuvSize.getEffectiveLibuvThreadCount(-100000)).to.equal(1024)
    })

    it('1024 if set to a very large value', function () {
      expect(libuvSize.getEffectiveLibuvThreadCount(1025)).to.equal(1024)
      expect(libuvSize.getEffectiveLibuvThreadCount(100000)).to.equal(1024)
    })
  })
})
