'use strict'

require('./setup/tap')

const { types } = require('util')
const path = require('path')
const Module = require('module')
const { getProxyModule } = require('../src/ritm-proxy')
const { assert } = require('chai')

const fs = require('fs')

const file = path.join(__dirname, 'ritm.spec.js')

function assertEqual (module, proxy, fn) {
  const res1 = fn(module)
  const res2 = fn(proxy)

  assert.equal(res1.toString(), res2.toString())
}

function isBound (func) { return func.name.startsWith('bound ') && !func.hasOwnProperty('prototype') }

describe('Ritm Proxy', () => {
  describe('fs', () => {
    it('should return a proxy', () => {
      const fsProxy = getProxyModule(fs, new Module('test'))

      assert.isNotNull(fsProxy)
      assert.isTrue(types.isProxy(fsProxy))
    })

    it('should return a bound fn for a deconstructed fn', () => {
      const { readFileSync: realReadFileSync } = require('fs')
      const { readFileSync } = getProxyModule(require('fs'), new Module('test'))

      assert.isNotNull(readFileSync)
      assert.isNotNull(realReadFileSync)
      assert.isTrue(isBound(readFileSync))
    })

    it('should keep original dir.readSync', () => {
      const fsProxy = getProxyModule(fs, new Module('test'))

      const dir = fs.opendirSync('./')
      const dirProxy = fsProxy.opendirSync('./')

      assert.equal(dir.readSync().name, dirProxy.readSync().name)
    })

    it('should keep original readFileSync', () => {
      const fsProxy = getProxyModule(fs, new Module('test'))

      assertEqual(fs, fsProxy, (fs) => fs.readFileSync(file))
    })

    it('should keep original decostructed readFileSync', () => {
      const { readFileSync } = getProxyModule(fs, new Module('test'))

      const res1 = fs.readFileSync(file)
      const res2 = readFileSync(file)

      assert.equal(res1.toString(), res2.toString())
    })

    it('should keep original existsSync', () => {
      const fsProxy = getProxyModule(fs, new Module('test'))

      assertEqual(fs, fsProxy, (fs) => fs.existsSync(file))
    })
  })

  describe('fs.promises', () => {
    it('should return a proxy', () => {
      const fsProxy = getProxyModule(fs, new Module('test'))

      assert.isNotNull(fsProxy.promises)
      assert.isTrue(types.isProxy(fsProxy.promises))
    })

    it('should keep original readFileSync', (done) => {
      const fsProxy = getProxyModule(fs, new Module('test'))

      Promise.all([
        fs.promises.readFile(file),
        fsProxy.promises.readFile(file)
      ]).then(values => {
        assert.equal(values[0].toString(), values[1].toString())
      }).finally(done)
    })
  })

  describe('fs.Dir', () => {
    it('should not return a bounded fn', () => {
      const fsProxy = getProxyModule(fs, new Module('test'))
      assert.isFalse(isBound(fsProxy.Dir))
    })
  })
})
