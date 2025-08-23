'use strict'

const proxyquire = require('proxyquire')
const waf = require('../../src/appsec/waf')
const web = require('../../../datadog-plugin-web/src/utils')
const { storage } = require('../../../datadog-core')
const addresses = require('../../src/appsec/addresses')

const {
  startGraphqlResolve,
  graphqlMiddlewareChannel,
  apolloChannel,
  apolloServerCoreChannel
} = require('../../src/appsec/channels')

describe('GraphQL', () => {
  let graphql, blocking, telemetry

  beforeEach(() => {
    const getBlockingData = sinon.stub()
    blocking = {
      getBlockingData,
      setTemplates: sinon.stub(),
      block: sinon.stub()
    }

    getBlockingData.returns({
      headers: { 'Content-type': 'application/json' },
      body: '{ "message": "blocked" }',
      statusCode: 403
    })

    telemetry = {
      updateBlockFailureMetric: sinon.stub()
    }

    graphql = proxyquire('../../src/appsec/graphql', {
      './blocking': blocking,
      './telemetry': telemetry
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('enable', () => {
    beforeEach(() => {
    })

    afterEach(() => {
      graphql.disable()
      sinon.restore()
    })

    it('Should subscribe to all channels', () => {
      expect(graphqlMiddlewareChannel.start.hasSubscribers).to.be.false
      expect(apolloChannel.start.hasSubscribers).to.be.false
      expect(apolloChannel.asyncEnd.hasSubscribers).to.be.false
      expect(apolloServerCoreChannel.start.hasSubscribers).to.be.false
      expect(apolloServerCoreChannel.asyncEnd.hasSubscribers).to.be.false
      expect(startGraphqlResolve.hasSubscribers).to.be.false

      graphql.enable()

      expect(graphqlMiddlewareChannel.start.hasSubscribers).to.be.true
      expect(apolloChannel.start.hasSubscribers).to.be.true
      expect(apolloChannel.asyncEnd.hasSubscribers).to.be.true
      expect(apolloServerCoreChannel.start.hasSubscribers).to.be.true
      expect(apolloServerCoreChannel.asyncEnd.hasSubscribers).to.be.true
      expect(startGraphqlResolve.hasSubscribers).to.be.true
    })
  })

  describe('disable', () => {
    it('Should unsubscribe from all channels', () => {
      graphql.enable()

      expect(graphqlMiddlewareChannel.start.hasSubscribers).to.be.true
      expect(apolloChannel.start.hasSubscribers).to.be.true
      expect(apolloChannel.asyncEnd.hasSubscribers).to.be.true
      expect(apolloServerCoreChannel.start.hasSubscribers).to.be.true
      expect(apolloServerCoreChannel.asyncEnd.hasSubscribers).to.be.true
      expect(startGraphqlResolve.hasSubscribers).to.be.true

      graphql.disable()

      expect(graphqlMiddlewareChannel.start.hasSubscribers).to.be.false
      expect(apolloChannel.start.hasSubscribers).to.be.false
      expect(apolloChannel.asyncEnd.hasSubscribers).to.be.false
      expect(apolloServerCoreChannel.start.hasSubscribers).to.be.false
      expect(apolloServerCoreChannel.asyncEnd.hasSubscribers).to.be.false
      expect(startGraphqlResolve.hasSubscribers).to.be.false
    })
  })

  describe('onGraphqlStartResolve', () => {
    beforeEach(() => {
      sinon.stub(waf, 'run').returns([''])
      sinon.stub(storage('legacy'), 'getStore').returns({ req: {} })
      sinon.stub(web, 'root').returns({})
      graphql.enable()
    })

    afterEach(() => {
      sinon.restore()
      graphql.disable()
    })

    it('Should not call waf if resolvers is undefined', () => {
      const context = {
        resolver: undefined
      }

      startGraphqlResolve.publish({ context })

      expect(waf.run).not.to.have.been.called
    })

    it('Should not call waf if resolvers is not an object', () => {
      const context = {
        resolver: ''
      }

      startGraphqlResolve.publish({ context })

      expect(waf.run).not.to.have.been.called
    })

    it('Should not call waf if req is unavailable', () => {
      const context = {}
      const resolverInfo = {
        user: [{ id: '1234' }]
      }

      storage('legacy').getStore().req = undefined

      startGraphqlResolve.publish({ context, resolverInfo })

      expect(waf.run).not.to.have.been.called
    })

    it('Should call waf if resolvers is well formatted', () => {
      const context = {}

      const resolverInfo = {
        user: [{ id: '1234' }]
      }

      startGraphqlResolve.publish({ context, resolverInfo })

      expect(waf.run).to.have.been.calledOnceWithExactly({
        ephemeral: {
          [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: resolverInfo
        }
      }, {})
    })
  })

  describe('block response', () => {
    const req = {}
    const res = {}
    const resolverInfo = {
      user: [{ id: '1234' }]
    }
    const blockParameters = {
      status_code: '401',
      type: 'auto',
      grpc_status_code: '10'
    }

    let context, rootSpan

    beforeEach(() => {
      sinon.stub(storage('legacy'), 'getStore').returns({ req, res })

      graphql.enable()
      graphqlMiddlewareChannel.start.publish({ req, res })
      apolloChannel.start.publish()
      context = {
        abortController: {
          abort: sinon.stub()
        }
      }
      rootSpan = { setTag: sinon.stub() }
    })

    afterEach(() => {
      graphql.disable()
      sinon.restore()
    })

    it('Should not call abort', () => {
      const abortController = {}

      sinon.stub(waf, 'run').returns([''])

      startGraphqlResolve.publish({ context, resolverInfo })

      expect(waf.run).to.have.been.calledOnceWithExactly({
        ephemeral: {
          [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: resolverInfo
        }
      }, {})

      expect(context.abortController.abort).not.to.have.been.called

      apolloChannel.asyncEnd.publish({ abortController })

      expect(blocking.getBlockingData).not.to.have.been.called
    })

    it('Should call abort', () => {
      const abortController = context.abortController

      sinon.stub(waf, 'run').returns({
        actions: {
          block_request: blockParameters
        }
      })

      sinon.stub(web, 'root').returns(rootSpan)

      startGraphqlResolve.publish({ context, resolverInfo })

      expect(waf.run).to.have.been.calledOnceWithExactly({
        ephemeral: {
          [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: resolverInfo
        }
      }, {})

      expect(context.abortController.abort).to.have.been.called

      const abortData = {}
      apolloChannel.asyncEnd.publish({ abortController, abortData })

      expect(blocking.getBlockingData).to.have.been.calledOnceWithExactly(req, 'graphql', blockParameters)

      expect(rootSpan.setTag).to.have.been.calledOnceWithExactly('appsec.blocked', 'true')
      expect(telemetry.updateBlockFailureMetric).to.not.have.been.called
    })

    it('Should catch error when block fails', () => {
      blocking.getBlockingData.returns(undefined)

      const abortController = context.abortController

      sinon.stub(waf, 'run').returns({
        actions: {
          block_request: blockParameters
        }
      })

      sinon.stub(web, 'root').returns(rootSpan)

      startGraphqlResolve.publish({ context, resolverInfo })

      expect(waf.run).to.have.been.calledOnceWithExactly({
        ephemeral: {
          [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: resolverInfo
        }
      }, {})

      expect(abortController.abort).to.have.been.calledOnce

      const abortData = {}
      apolloChannel.asyncEnd.publish({ abortController, abortData })

      expect(blocking.getBlockingData).to.have.been.calledOnceWithExactly(req, 'graphql', blockParameters)

      expect(rootSpan.setTag).to.have.been.calledOnceWithExactly('_dd.appsec.block.failed', 1)
      expect(telemetry.updateBlockFailureMetric).to.be.calledOnceWithExactly(req)
    })
  })
})
