'use strict'

const assert = require('node:assert/strict')
const { promisify } = require('node:util')

const { describe, it, before, after, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { channel } = require('../src/helpers/instrument')

const startCh = channel('apm:crypto:operation:start')
const finishCh = channel('apm:crypto:operation:finish')
const errorCh = channel('apm:crypto:operation:error')
const hashingCh = channel('datadog:crypto:hashing:start')
const cipherCh = channel('datadog:crypto:cipher:start')

;['crypto', 'node:crypto'].forEach(moduleName => {
  describe(moduleName, () => {
    let crypto, start, finish, error, hashing, cipher

    before(() => agent.load('crypto'))
    after(() => agent.close({ ritmReset: false }))

    beforeEach(() => {
      start = sinon.stub()
      finish = sinon.stub()
      error = sinon.stub()
      hashing = sinon.stub()
      cipher = sinon.stub()
      startCh.subscribe(start)
      finishCh.subscribe(finish)
      errorCh.subscribe(error)
      hashingCh.subscribe(hashing)
      cipherCh.subscribe(cipher)
      crypto = require(moduleName)
    })

    afterEach(() => {
      startCh.unsubscribe(start)
      finishCh.unsubscribe(finish)
      errorCh.unsubscribe(error)
      hashingCh.unsubscribe(hashing)
      cipherCh.unsubscribe(cipher)
    })

    describe('async APIs', () => {
      it('publishes pbkdf2 with iterations, keylen, digest captured', async () => {
        await promisify(crypto.pbkdf2)('password', 'salt', 1000, 32, 'sha256')
        sinon.assert.calledOnceWithMatch(start, {
          operation: 'pbkdf2',
          iterations: 1000,
          keylen: 32,
          digest: 'sha256',
        })
        sinon.assert.calledOnce(finish)
        sinon.assert.notCalled(error)
        // Password and salt sit at unused positions and must not appear on the context.
        const ctx = start.firstCall.firstArg
        assert.equal('password' in ctx, false)
        assert.equal('salt' in ctx, false)
      })

      it('publishes randomBytes with size captured', async () => {
        const buf = await promisify(crypto.randomBytes)(16)
        assert.equal(buf.length, 16)
        sinon.assert.calledOnceWithMatch(start, { operation: 'randomBytes', size: 16 })
        sinon.assert.calledOnce(finish)
      })

      it('publishes randomFill with offset and size', done => {
        crypto.randomFill(Buffer.alloc(16), 4, 8, err => {
          assert.equal(err, null)
          sinon.assert.calledOnceWithMatch(start, { operation: 'randomFill', offset: 4, size: 8 })
          sinon.assert.calledOnce(finish)
          done()
        })
      })

      it('publishes generateKeyPair with type captured', done => {
        crypto.generateKeyPair('rsa', { modulusLength: 1024 }, err => {
          assert.equal(err, null)
          sinon.assert.calledOnceWithMatch(start, { operation: 'generateKeyPair', type: 'rsa' })
          sinon.assert.calledOnce(finish)
          done()
        })
      })

      it('publishes hkdf with digest and keylen captured but ikm/salt/info skipped', async () => {
        await promisify(crypto.hkdf)('sha256', Buffer.from('ikm'), Buffer.from('salt'), Buffer.from('info'), 32)
        sinon.assert.calledOnceWithMatch(start, { operation: 'hkdf', digest: 'sha256', keylen: 32 })
        const ctx = start.firstCall.firstArg
        assert.equal('ikm' in ctx, false)
        assert.equal('salt' in ctx, false)
        assert.equal('info' in ctx, false)
      })

      it('omits non-string non-number arguments at captured positions', async () => {
        // crypto.sign captures arguments[0] as 'algorithm', which can be null for some keys.
        // A null algorithm must not be forwarded as a label since it is not a string or number.
        const { privateKey } = crypto.generateKeyPairSync('ed25519')
        await promisify(crypto.sign)(null, Buffer.from('msg'), privateKey)
        sinon.assert.calledOnce(start)
        const ctx = start.firstCall.firstArg
        assert.equal(ctx.operation, 'sign')
        assert.equal('algorithm' in ctx, false)
      })

      it('publishes error and rethrows on synchronous failure', () => {
        assert.throws(() => crypto.pbkdf2('p', 's', 1, 32, 'not-a-real-digest', () => {}))
        sinon.assert.calledOnce(start)
        sinon.assert.calledOnce(error)
      })

      it('publishes error on asynchronous failure', done => {
        // RSA modulus 100 bits is below the OpenSSL minimum and surfaces as a callback error.
        crypto.generateKeyPair('rsa', { modulusLength: 100 }, err => {
          assert.ok(err)
          sinon.assert.calledOnce(start)
          sinon.assert.calledOnce(error)
          sinon.assert.calledOnce(finish)
          done()
        })
      })

      it('does not publish when called without a callback', () => {
        // randomBytes has a documented sync overload when no callback is given.
        const buf = crypto.randomBytes(8)
        assert.equal(buf.length, 8)
        sinon.assert.notCalled(start)
        sinon.assert.notCalled(finish)
      })
    })

    describe('AppSec channels (preserved)', () => {
      it('publishes datadog:crypto:hashing:start for createHash', () => {
        crypto.createHash('sha256').update('x').digest('hex')
        sinon.assert.calledOnceWithMatch(hashing, { algorithm: 'sha256' })
      })

      it('publishes datadog:crypto:cipher:start for createCipheriv', () => {
        const key = crypto.randomBytes(32)
        const iv = crypto.randomBytes(16)
        const c = crypto.createCipheriv('aes-256-cbc', key, iv)
        c.update('x')
        c.final()
        sinon.assert.calledOnceWithMatch(cipher, { algorithm: 'aes-256-cbc' })
      })
    })
  })
})
