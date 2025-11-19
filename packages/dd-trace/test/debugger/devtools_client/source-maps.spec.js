'use strict'

const assert = require('node:assert/strict')

const { expect } = require('chai')
const { after, before, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')
require('../../setup/mocha')

const parsedSourceMap = {
  version: 3,
  file: 'index.js',
  sourceRoot: '',
  sources: ['index.ts'],
  names: [],
  mappings: ';AAAA,MAAM,UAAU,GAAG,IAAI,CAAC;AACxB,OAAO,CAAC,GAAG,CAAC,UAAU,CAAC,CAAC'
}
const dir = '/foo'
const sourceMapURL = 'index.map.js'
const rawSourceMap = JSON.stringify(parsedSourceMap)
const inlineSourceMap = `data:application/json;base64,${Buffer.from(rawSourceMap).toString('base64')}`

describe('source map utils', function () {
  let loadSourceMap, loadSourceMapSync, getGeneratedPosition, readFileSync, readFile

  describe('basic', function () {
    beforeEach(function () {
      readFileSync = sinon.stub().returns(rawSourceMap)
      readFile = sinon.stub().resolves(rawSourceMap)

      const sourceMaps = proxyquire('../../../src/debugger/devtools_client/source-maps', {
        fs: { readFileSync },
        'fs/promises': { readFile }
      })

      loadSourceMap = sourceMaps.loadSourceMap
      loadSourceMapSync = sourceMaps.loadSourceMapSync
      getGeneratedPosition = sourceMaps.getGeneratedPosition
    })

    describe('loadSourceMap', function () {
      it('should return parsed inline source map', async function () {
        const sourceMap = await loadSourceMap(dir, inlineSourceMap)
        assert.deepStrictEqual(sourceMap, parsedSourceMap)
        sinon.assert.notCalled(readFile)
      })

      it('should throw is inline source map is invalid', function (done) {
        loadSourceMap(dir, inlineSourceMap.slice(0, -10))
          .then(() => {
            done(new Error('Should not resolve promise'))
          })
          .catch(() => {
            done()
          })
      })

      it('should return parsed source map', async function () {
        const sourceMap = await loadSourceMap(dir, sourceMapURL)
        assert.deepStrictEqual(sourceMap, parsedSourceMap)
        sinon.assert.calledOnceWith(readFile, '/foo/index.map.js', 'utf8')
      })
    })

    describe('loadSourceMapSync', function () {
      it('should return parsed inline source map', function () {
        const sourceMap = loadSourceMapSync(dir, inlineSourceMap)
        assert.deepStrictEqual(sourceMap, parsedSourceMap)
        sinon.assert.notCalled(readFileSync)
      })

      it('should throw if inline source map is invalid', function () {
        expect(() => {
          loadSourceMapSync(dir, inlineSourceMap.slice(0, -10))
        }).to.throw()
      })

      it('should return parsed source map', function () {
        const sourceMap = loadSourceMapSync(dir, sourceMapURL)
        assert.deepStrictEqual(sourceMap, parsedSourceMap)
        sinon.assert.calledOnceWith(readFileSync, '/foo/index.map.js', 'utf8')
      })
    })

    describe('getGeneratedPosition', function () {
      const url = `file://${dir}/${parsedSourceMap.file}`
      const source = parsedSourceMap.sources[0]
      const line = 1

      it('should return expected line for inline source map', async function () {
        const pos = await getGeneratedPosition(url, source, line, sourceMapURL)
        assert.deepStrictEqual(pos, { line: 2, column: 0, lastColumn: 5 })
      })

      it('should return expected line for non-inline source map', async function () {
        const pos = await getGeneratedPosition(url, source, line, inlineSourceMap)
        assert.deepStrictEqual(pos, { line: 2, column: 0, lastColumn: 5 })
      })
    })
  })

  describe('cache', function () {
    let clock

    function setup () {
      clock = sinon.useFakeTimers({
        toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
      })
      readFileSync = sinon.stub().returns(rawSourceMap)
      readFile = sinon.stub().resolves(rawSourceMap)

      const sourceMaps = proxyquire('../../../src/debugger/devtools_client/source-maps', {
        fs: { readFileSync },
        'fs/promises': { readFile }
      })

      loadSourceMap = sourceMaps.loadSourceMap
      loadSourceMapSync = sourceMaps.loadSourceMapSync
    }

    function teardown () {
      clock.restore()
    }

    describe('loadSourceMap', function () {
      before(setup)

      after(teardown)

      it('should read from disk on the fist call', async function () {
        const sourceMap = await loadSourceMap(dir, sourceMapURL)
        assert.deepStrictEqual(sourceMap, parsedSourceMap)
        assert.strictEqual(readFile.callCount, 1)
      })

      it('should not read from disk on the second call', async function () {
        const sourceMap = await loadSourceMap(dir, sourceMapURL)
        assert.deepStrictEqual(sourceMap, parsedSourceMap)
        assert.strictEqual(readFile.callCount, 1)
      })

      it('should clear cache after 5 seconds', async function () {
        clock.tick(5_000)
        const sourceMap = await loadSourceMap(dir, sourceMapURL)
        assert.deepStrictEqual(sourceMap, parsedSourceMap)
        assert.strictEqual(readFile.callCount, 2)
      })
    })

    describe('loadSourceMapSync', function () {
      before(setup)

      after(teardown)

      it('should read from disk on the fist call', function () {
        const sourceMap = loadSourceMapSync(dir, sourceMapURL)
        assert.deepStrictEqual(sourceMap, parsedSourceMap)
        assert.strictEqual(readFileSync.callCount, 1)
      })

      it('should not read from disk on the second call', function () {
        const sourceMap = loadSourceMapSync(dir, sourceMapURL)
        assert.deepStrictEqual(sourceMap, parsedSourceMap)
        assert.strictEqual(readFileSync.callCount, 1)
      })

      it('should clear cache after 5 seconds', function () {
        clock.tick(5_000)
        const sourceMap = loadSourceMapSync(dir, sourceMapURL)
        assert.deepStrictEqual(sourceMap, parsedSourceMap)
        assert.strictEqual(readFileSync.callCount, 2)
      })
    })
  })
})
