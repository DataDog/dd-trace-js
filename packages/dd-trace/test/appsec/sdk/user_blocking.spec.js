'use strict'

const assert = require('node:assert/strict')

const { before, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { USER_ID } = require('../../../src/appsec/addresses')
const waf = require('../../../src/appsec/waf')
const resultActions = {
  actions: {
    block_request: {
      status_code: 401,
      type: 'auto',
      grpc_status_code: 10
    }
  }
}

describe('user_blocking - Internal API', () => {
  const req = { protocol: 'https' }
  const res = { headersSent: false }
  const tracer = {}

  let rootSpan, getRootSpan, block, legacyStorage, log, userBlocking

  before(() => {
    const runStub = sinon.stub(waf, 'run')
    runStub.withArgs({ persistent: { [USER_ID]: 'user' } }).returns(resultActions)
    runStub.withArgs({ persistent: { [USER_ID]: 'gooduser' } }).returns({})
  })

  beforeEach(() => {
    rootSpan = {
      context: () => {
        return { _tags: {} }
      },
      setTag: sinon.stub()
    }
    getRootSpan = sinon.stub().returns(rootSpan)

    block = sinon.stub().returns(true)

    legacyStorage = {
      getStore: sinon.stub().returns({ req, res })
    }

    log = {
      warn: sinon.stub()
    }

    userBlocking = proxyquire('../../../src/appsec/sdk/user_blocking', {
      './utils': { getRootSpan },
      '../blocking': { block },
      '../../../../datadog-core': { storage: () => legacyStorage },
      '../../log': log
    })
  })

  describe('checkUserAndSetUser', () => {
    it('should return false and log warn when passed no user', () => {
      const ret = userBlocking.checkUserAndSetUser()
      assert.strictEqual(ret, false)
      sinon.assert.calledOnceWithExactly(log.warn, '[ASM] Invalid user provided to isUserBlocked')
    })

    it('should return false and log warn when passed invalid user', () => {
      const ret = userBlocking.checkUserAndSetUser({})
      assert.strictEqual(ret, false)
      sinon.assert.calledOnceWithExactly(log.warn, '[ASM] Invalid user provided to isUserBlocked')
    })

    it('should set user when not already set', () => {
      const ret = userBlocking.checkUserAndSetUser(tracer, { id: 'user' })
      assert.strictEqual(ret, true)
      sinon.assert.calledOnceWithExactly(getRootSpan, tracer)
      sinon.assert.calledWithExactly(rootSpan.setTag, 'usr.id', 'user')
      sinon.assert.calledWithExactly(rootSpan.setTag, '_dd.appsec.user.collection_mode', 'sdk')
    })

    it('should not override user when already set', () => {
      rootSpan.context = () => {
        return { _tags: { 'usr.id': 'mockUser' } }
      }

      const ret = userBlocking.checkUserAndSetUser(tracer, { id: 'user' })
      assert.strictEqual(ret, true)
      sinon.assert.calledOnceWithExactly(getRootSpan, tracer)
      sinon.assert.notCalled(rootSpan.setTag)
    })

    it('should log warn when rootSpan is not available', () => {
      getRootSpan.returns(undefined)

      const ret = userBlocking.checkUserAndSetUser(tracer, { id: 'user' })
      assert.strictEqual(ret, true)
      sinon.assert.calledOnceWithExactly(getRootSpan, tracer)
      sinon.assert.calledOnceWithExactly(log.warn, '[ASM] Root span not available in isUserBlocked')
      sinon.assert.notCalled(rootSpan.setTag)
    })

    it('should return false when received no results', () => {
      const ret = userBlocking.checkUserAndSetUser(tracer, { id: 'gooduser' })
      assert.strictEqual(ret, false)
      sinon.assert.calledWithExactly(rootSpan.setTag, 'usr.id', 'gooduser')
      sinon.assert.calledWithExactly(rootSpan.setTag, '_dd.appsec.user.collection_mode', 'sdk')
    })
  })

  describe('blockRequest', () => {
    it('should get req and res from local storage when they are not passed', () => {
      const ret = userBlocking.blockRequest(tracer)
      assert.strictEqual(ret, true)
      sinon.assert.calledOnce(legacyStorage.getStore)
      sinon.assert.calledOnceWithExactly(block, req, res, rootSpan)
    })

    it('should log warning when req or res is not available', () => {
      legacyStorage.getStore.returns(undefined)

      const ret = userBlocking.blockRequest(tracer)
      assert.strictEqual(ret, false)
      sinon.assert.calledOnce(legacyStorage.getStore)
      sinon.assert.calledOnceWithExactly(log.warn, '[ASM] Requests or response object not available in blockRequest')
      sinon.assert.notCalled(block)
    })

    it('should return false and log warn when rootSpan is not available', () => {
      getRootSpan.returns(undefined)

      const ret = userBlocking.blockRequest(tracer, {}, {})
      assert.strictEqual(ret, false)
      sinon.assert.calledOnceWithExactly(log.warn, '[ASM] Root span not available in blockRequest')
      sinon.assert.notCalled(block)
    })

    it('should call block with proper arguments', () => {
      const req = {}
      const res = {}
      const ret = userBlocking.blockRequest(tracer, req, res)
      assert.strictEqual(ret, true)
      sinon.assert.notCalled(log.warn)
      sinon.assert.calledOnceWithExactly(block, req, res, rootSpan)
    })
  })
})
