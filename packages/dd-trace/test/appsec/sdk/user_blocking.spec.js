'use strict'

const proxyquire = require('proxyquire')
const waf = require('../../../src/appsec/waf')
const { USER_ID } = require('../../../src/appsec/addresses')

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
      expect(ret).to.be.false
      expect(log.warn).to.have.been.calledOnceWithExactly('[ASM] Invalid user provided to isUserBlocked')
    })

    it('should return false and log warn when passed invalid user', () => {
      const ret = userBlocking.checkUserAndSetUser({})
      expect(ret).to.be.false
      expect(log.warn).to.have.been.calledOnceWithExactly('[ASM] Invalid user provided to isUserBlocked')
    })

    it('should set user when not already set', () => {
      const ret = userBlocking.checkUserAndSetUser(tracer, { id: 'user' })
      expect(ret).to.be.true
      expect(getRootSpan).to.have.been.calledOnceWithExactly(tracer)
      expect(rootSpan.setTag).to.have.been.calledWithExactly('usr.id', 'user')
      expect(rootSpan.setTag).to.have.been.calledWithExactly('_dd.appsec.user.collection_mode', 'sdk')
    })

    it('should not override user when already set', () => {
      rootSpan.context = () => {
        return { _tags: { 'usr.id': 'mockUser' } }
      }

      const ret = userBlocking.checkUserAndSetUser(tracer, { id: 'user' })
      expect(ret).to.be.true
      expect(getRootSpan).to.have.been.calledOnceWithExactly(tracer)
      expect(rootSpan.setTag).to.not.have.been.called
    })

    it('should log warn when rootSpan is not available', () => {
      getRootSpan.returns(undefined)

      const ret = userBlocking.checkUserAndSetUser(tracer, { id: 'user' })
      expect(ret).to.be.true
      expect(getRootSpan).to.have.been.calledOnceWithExactly(tracer)
      expect(log.warn).to.have.been.calledOnceWithExactly('[ASM] Root span not available in isUserBlocked')
      expect(rootSpan.setTag).to.not.have.been.called
    })

    it('should return false when received no results', () => {
      const ret = userBlocking.checkUserAndSetUser(tracer, { id: 'gooduser' })
      expect(ret).to.be.false
      expect(rootSpan.setTag).to.have.been.calledWithExactly('usr.id', 'gooduser')
      expect(rootSpan.setTag).to.have.been.calledWithExactly('_dd.appsec.user.collection_mode', 'sdk')
    })
  })

  describe('blockRequest', () => {
    it('should get req and res from local storage when they are not passed', () => {
      const ret = userBlocking.blockRequest(tracer)
      expect(ret).to.be.true
      expect(legacyStorage.getStore).to.have.been.calledOnce
      expect(block).to.be.calledOnceWithExactly(req, res, rootSpan)
    })

    it('should log warning when req or res is not available', () => {
      legacyStorage.getStore.returns(undefined)

      const ret = userBlocking.blockRequest(tracer)
      expect(ret).to.be.false
      expect(legacyStorage.getStore).to.have.been.calledOnce
      expect(log.warn)
        .to.have.been.calledOnceWithExactly('[ASM] Requests or response object not available in blockRequest')
      expect(block).to.not.have.been.called
    })

    it('should return false and log warn when rootSpan is not available', () => {
      getRootSpan.returns(undefined)

      const ret = userBlocking.blockRequest(tracer, {}, {})
      expect(ret).to.be.false
      expect(log.warn).to.have.been.calledOnceWithExactly('[ASM] Root span not available in blockRequest')
      expect(block).to.not.have.been.called
    })

    it('should call block with proper arguments', () => {
      const req = {}
      const res = {}
      const ret = userBlocking.blockRequest(tracer, req, res)
      expect(ret).to.be.true
      expect(log.warn).to.not.have.been.called
      expect(block).to.have.been.calledOnceWithExactly(req, res, rootSpan)
    })
  })
})
