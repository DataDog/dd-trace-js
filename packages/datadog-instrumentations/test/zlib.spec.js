'use strict'

const assert = require('node:assert/strict')
const { promisify } = require('node:util')

const { describe, it, before, after, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { channel } = require('../src/helpers/instrument')

const startCh = channel('apm:zlib:operation:start')
const finishCh = channel('apm:zlib:operation:finish')
const errorCh = channel('apm:zlib:operation:error')

const compressionPairs = [
  ['gzip', 'gunzip', 'gzipSync'],
  ['deflate', 'inflate', 'deflateSync'],
  ['deflateRaw', 'inflateRaw', 'deflateRawSync'],
  ['brotliCompress', 'brotliDecompress', 'brotliCompressSync'],
]

;['zlib', 'node:zlib'].forEach(moduleName => {
  describe(moduleName, () => {
    let zlib, start, finish, error

    before(() => agent.load('zlib'))
    after(() => agent.close({ ritmReset: false }))

    beforeEach(() => {
      start = sinon.stub()
      finish = sinon.stub()
      error = sinon.stub()
      startCh.subscribe(start)
      finishCh.subscribe(finish)
      errorCh.subscribe(error)
      zlib = require(moduleName)
    })

    afterEach(() => {
      startCh.unsubscribe(start)
      finishCh.unsubscribe(finish)
      errorCh.unsubscribe(error)
    })

    for (const [encode, decode, encodeSync] of compressionPairs) {
      it(`publishes start and finish for ${encode}`, async () => {
        await promisify(zlib[encode])(Buffer.from('hello world'))
        sinon.assert.calledOnceWithMatch(start, { operation: encode })
        sinon.assert.calledOnceWithMatch(finish, { operation: encode })
        sinon.assert.notCalled(error)
      })

      it(`publishes start and finish for ${decode}`, async () => {
        const compressed = zlib[encodeSync](Buffer.from('hello world'))
        const decompressed = await promisify(zlib[decode])(compressed)
        assert.equal(decompressed.toString(), 'hello world')
        sinon.assert.calledOnceWithMatch(start, { operation: decode })
        sinon.assert.calledOnceWithMatch(finish, { operation: decode })
        sinon.assert.notCalled(error)
      })
    }

    it('publishes start and finish for unzip', async () => {
      const compressed = zlib.gzipSync(Buffer.from('hello world'))
      const decompressed = await promisify(zlib.unzip)(compressed)
      assert.equal(decompressed.toString(), 'hello world')
      sinon.assert.calledOnceWithMatch(start, { operation: 'unzip' })
      sinon.assert.calledOnceWithMatch(finish, { operation: 'unzip' })
      sinon.assert.notCalled(error)
    })

    it('publishes error when decompression fails', async () => {
      await assert.rejects(promisify(zlib.gunzip)(Buffer.from('not gzipped')))
      sinon.assert.calledOnce(start)
      sinon.assert.calledOnce(error)
      sinon.assert.calledOnce(finish)
    })

    it('does not publish when called without a callback', () => {
      assert.throws(() => zlib.gzip(Buffer.from('hi')))
      sinon.assert.notCalled(start)
    })

    it('publishes for zstdCompress and zstdDecompress', async function () {
      if (typeof zlib.zstdCompress !== 'function') return this.skip()
      const compressed = await promisify(zlib.zstdCompress)(Buffer.from('hello'))
      sinon.assert.calledWithMatch(start, { operation: 'zstdCompress' })

      start.resetHistory()
      finish.resetHistory()

      const decompressed = await promisify(zlib.zstdDecompress)(compressed)
      assert.equal(decompressed.toString(), 'hello')
      sinon.assert.calledWithMatch(start, { operation: 'zstdDecompress' })
      sinon.assert.calledOnce(finish)
    })
  })
})
