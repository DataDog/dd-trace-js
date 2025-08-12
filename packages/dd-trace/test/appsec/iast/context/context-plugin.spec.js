'use strict'

const proxyquire = require('proxyquire')
const { IastPlugin } = require('../../../../src/appsec/iast/iast-plugin')
const { TagKey } = require('../../../../src/appsec/iast/telemetry/iast-metric')
const { storage } = require('../../../../../datadog-core')
const { IAST_ENABLED_TAG_KEY } = require('../../../../src/appsec/iast/tags')

describe('IastContextPlugin', () => {
  let IastContextPlugin, addSub, getAndRegisterSubscription
  let plugin
  let acquireRequest, initializeRequestContext, releaseRequest
  let saveIastContext, getIastContext, cleanIastContext
  let createTransaction, removeTransaction
  let sendVulnerabilities

  beforeEach(() => {
    addSub = sinon.stub(IastPlugin.prototype, 'addSub')
    getAndRegisterSubscription = sinon.stub(IastPlugin.prototype, '_getAndRegisterSubscription')

    acquireRequest = sinon.stub()
    initializeRequestContext = sinon.stub()
    releaseRequest = sinon.stub()

    saveIastContext = sinon.stub()
    getIastContext = sinon.stub()
    cleanIastContext = sinon.stub()

    createTransaction = sinon.stub()
    removeTransaction = sinon.stub()

    sendVulnerabilities = sinon.stub()

    IastContextPlugin = proxyquire('../../../../src/appsec/iast/context/context-plugin', {
      '../iast-plugin': { IastPlugin },
      '../overhead-controller': {
        acquireRequest,
        initializeRequestContext,
        releaseRequest
      },
      '../iast-context': {
        saveIastContext,
        getIastContext,
        cleanIastContext
      },
      '../taint-tracking/operations': {
        createTransaction,
        removeTransaction
      },
      '../vulnerability-reporter': {
        sendVulnerabilities
      }
    })

    plugin = new IastContextPlugin()
  })

  afterEach(sinon.restore)

  describe('startCtxOn', () => {
    const channelName = 'start'
    const tag = {}

    it('should add a subscription to the channel', () => {
      plugin.startCtxOn(channelName, tag)

      expect(addSub).to.be.calledOnceWith(channelName)
      expect(getAndRegisterSubscription).to.be.calledOnceWith({ channelName, tag, tagKey: TagKey.SOURCE_TYPE })
    })

    it('should call startContext when event is published', () => {
      plugin.startCtxOn(channelName, tag)

      const startContext = sinon.stub(plugin, 'startContext')
        .returns({ isRequestAcquired: true, iastContext: {}, store: {} })

      addSub.firstCall.args[1]()

      expect(startContext).to.be.calledOnce
    })
  })

  describe('finishCtxOn', () => {
    const channelName = 'finish'

    it('should add a subscription to the channel', () => {
      plugin.finishCtxOn(channelName)

      expect(addSub).to.be.calledOnceWith(channelName)
    })

    it('should call finishContext when event is published', () => {
      plugin.finishCtxOn(channelName)

      const finishContext = sinon.stub(plugin, 'finishContext')
        .returns({ isRequestAcquired: true, iastContext: {}, store: {} })

      addSub.firstCall.args[1]()

      expect(finishContext).to.be.calledOnce
    })
  })

  describe('startContext', () => {
    const topContext = {}
    const rootSpan = {
      context: () => {
        return {
          toSpanId: () => 'span-id'
        }
      },

      addTags: () => {}
    }

    const store = {
      span: rootSpan
    }

    let getStore

    beforeEach(() => {
      getStore = sinon.stub(storage('legacy'), 'getStore')
      getStore.returns(store)
    })

    it('should obtain needed info from data before starting iast context', () => {
      sinon.stub(plugin, 'getTopContext').returns(topContext)
      sinon.stub(plugin, 'getRootSpan').returns(rootSpan)

      plugin.startContext()

      expect(plugin.getTopContext).to.be.calledOnce
      expect(plugin.getRootSpan).to.be.calledWith(store)
    })

    it('should call overheadController before starting iast context', () => {
      plugin.startContext()

      expect(acquireRequest).to.be.calledOnceWith(rootSpan)
    })

    it('should add _dd.iast.enabled:0 tag in the rootSpan', () => {
      const addTags = sinon.stub(rootSpan, 'addTags')
      plugin.startContext()

      expect(addTags).to.be.calledOnceWith({ [IAST_ENABLED_TAG_KEY]: 0 })
    })

    it('should not fail if store does not contain span', () => {
      getStore.returns({})

      plugin.startContext()

      expect(acquireRequest).to.be.calledOnceWith(undefined)
    })

    describe('if acquireRequest', () => {
      let context, newIastContext

      beforeEach(() => {
        acquireRequest.returns(true)

        context = {}
        newIastContext = sinon.stub(plugin, 'newIastContext').returns(context)

        saveIastContext.returns(context)
      })

      it('should add _dd.iast.enabled: 1 tag in the rootSpan', () => {
        const addTags = sinon.stub(rootSpan, 'addTags')
        plugin.startContext()

        expect(addTags).to.be.calledOnceWith({ [IAST_ENABLED_TAG_KEY]: 1 })
      })

      it('should create and save new IAST context and store it', () => {
        plugin.startContext()

        expect(newIastContext).to.be.calledOnceWith(rootSpan)
        expect(saveIastContext).to.be.calledOnceWith(store, topContext, context)
      })

      it('should create new taint-tracking transaction', () => {
        plugin.startContext()

        expect(createTransaction).to.be.calledOnceWith('span-id', context)
      })

      it('should obtain needed info from data before starting iast context', () => {
        plugin.startContext()

        expect(initializeRequestContext).to.be.calledOnceWith(context)
      })
    })
  })

  describe('finishContext', () => {
    const store = {}

    beforeEach(() => {
      sinon.stub(storage('legacy'), 'getStore').returns(store)
    })

    it('should send the vulnerabilities if any', () => {
      const rootSpan = {}
      const vulnerabilities = []

      getIastContext.returns({
        rootSpan: {},
        vulnerabilities: []
      })

      plugin.finishContext()

      expect(sendVulnerabilities).to.be.calledOnceWith(vulnerabilities, rootSpan)
    })

    it('should remove the taint-tracking transaction', () => {
      const iastContext = {
        rootSpan: {},
        vulnerabilities: []
      }

      getIastContext.returns(iastContext)

      plugin.finishContext()

      expect(removeTransaction).to.be.calledOnceWith(iastContext)
    })

    it('should clear iastContext and releaseRequest from OCE', () => {
      const iastContext = {
        rootSpan: {},
        vulnerabilities: []
      }

      cleanIastContext.returns(true)
      getIastContext.returns(iastContext)

      plugin.finishContext()

      expect(cleanIastContext).to.be.calledOnce
      expect(releaseRequest).to.be.calledOnce
    })

    it('should not fail if there is no iastContext', () => {
      getIastContext.returns(undefined)

      plugin.finishContext()

      expect(cleanIastContext).to.be.calledOnce
    })
  })
})
