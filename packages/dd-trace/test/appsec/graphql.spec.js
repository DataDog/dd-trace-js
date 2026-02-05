'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { storage } = require('../../../datadog-core')
const addresses = require('../../src/appsec/addresses')
const waf = require('../../src/appsec/waf')
const web = require('../../src/plugins/util/web')
const {
  startGraphqlResolver,
  graphqlMiddlewareChannel,
  apolloChannel,
  apolloServerCoreChannel,
} = require('../../src/appsec/channels')

describe('GraphQL', () => {
  let graphql, blocking, telemetry

  beforeEach(() => {
    const getBlockingData = sinon.stub()
    blocking = {
      getBlockingData,
      setTemplates: sinon.stub(),
      block: sinon.stub(),
    }

    getBlockingData.returns({
      headers: { 'Content-type': 'application/json' },
      body: '{ "message": "blocked" }',
      statusCode: 403,
    })

    telemetry = {
      updateBlockFailureMetric: sinon.stub(),
    }

    graphql = proxyquire('../../src/appsec/graphql', {
      './blocking': blocking,
      './telemetry': telemetry,
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
      assert.strictEqual(graphqlMiddlewareChannel.start.hasSubscribers, false)
      assert.strictEqual(apolloChannel.start.hasSubscribers, false)
      assert.strictEqual(apolloChannel.asyncEnd.hasSubscribers, false)
      assert.strictEqual(apolloServerCoreChannel.start.hasSubscribers, false)
      assert.strictEqual(apolloServerCoreChannel.asyncEnd.hasSubscribers, false)
      assert.strictEqual(startGraphqlResolver.hasSubscribers, false)

      graphql.enable()

      assert.strictEqual(graphqlMiddlewareChannel.start.hasSubscribers, true)
      assert.strictEqual(apolloChannel.start.hasSubscribers, true)
      assert.strictEqual(apolloChannel.asyncEnd.hasSubscribers, true)
      assert.strictEqual(apolloServerCoreChannel.start.hasSubscribers, true)
      assert.strictEqual(apolloServerCoreChannel.asyncEnd.hasSubscribers, true)
      assert.strictEqual(startGraphqlResolver.hasSubscribers, true)
    })
  })

  describe('disable', () => {
    it('Should unsubscribe from all channels', () => {
      graphql.enable()

      assert.strictEqual(graphqlMiddlewareChannel.start.hasSubscribers, true)
      assert.strictEqual(apolloChannel.start.hasSubscribers, true)
      assert.strictEqual(apolloChannel.asyncEnd.hasSubscribers, true)
      assert.strictEqual(apolloServerCoreChannel.start.hasSubscribers, true)
      assert.strictEqual(apolloServerCoreChannel.asyncEnd.hasSubscribers, true)
      assert.strictEqual(startGraphqlResolver.hasSubscribers, true)

      graphql.disable()

      assert.strictEqual(graphqlMiddlewareChannel.start.hasSubscribers, false)
      assert.strictEqual(apolloChannel.start.hasSubscribers, false)
      assert.strictEqual(apolloChannel.asyncEnd.hasSubscribers, false)
      assert.strictEqual(apolloServerCoreChannel.start.hasSubscribers, false)
      assert.strictEqual(apolloServerCoreChannel.asyncEnd.hasSubscribers, false)
      assert.strictEqual(startGraphqlResolver.hasSubscribers, false)
    })
  })

  describe('onGraphqlStartResolver', () => {
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
        resolver: undefined,
      }

      startGraphqlResolver.publish({ context })

      sinon.assert.notCalled(waf.run)
    })

    it('Should not call waf if resolvers is not an object', () => {
      const context = {
        resolver: '',
      }

      startGraphqlResolver.publish({ context })

      sinon.assert.notCalled(waf.run)
    })

    it('Should not call waf if req is unavailable', () => {
      const context = {}
      const resolverInfo = {
        user: [{ id: '1234' }],
      }

      storage('legacy').getStore().req = undefined

      startGraphqlResolver.publish({ context, resolverInfo })

      sinon.assert.notCalled(waf.run)
    })

    it('Should call waf if resolvers is well formatted', () => {
      const context = {}

      const resolverInfo = {
        user: [{ id: '1234' }],
      }

      startGraphqlResolver.publish({ context, resolverInfo })

      sinon.assert.calledOnceWithExactly(waf.run, {
        ephemeral: {
          [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: resolverInfo,
        },
      }, {})
    })
  })

  describe('block response', () => {
    const req = {}
    const res = {}
    const resolverInfo = {
      user: [{ id: '1234' }],
    }
    const blockParameters = {
      status_code: 401,
      type: 'auto',
      grpc_status_code: 10,
    }

    let context, rootSpan

    beforeEach(() => {
      sinon.stub(storage('legacy'), 'getStore').returns({ req, res })

      graphql.enable()
      graphqlMiddlewareChannel.start.publish({ req, res })
      apolloChannel.start.publish()
      context = {
        abortController: {
          abort: sinon.stub(),
        },
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

      startGraphqlResolver.publish({ context, resolverInfo })

      sinon.assert.calledOnceWithExactly(waf.run, {
        ephemeral: {
          [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: resolverInfo,
        },
      }, {})

      sinon.assert.notCalled(context.abortController.abort)

      apolloChannel.asyncEnd.publish({ abortController })

      sinon.assert.notCalled(blocking.getBlockingData)
    })

    it('Should call abort', () => {
      const abortController = context.abortController

      sinon.stub(waf, 'run').returns({
        actions: {
          block_request: blockParameters,
        },
      })

      sinon.stub(web, 'root').returns(rootSpan)

      startGraphqlResolver.publish({ context, resolverInfo })

      sinon.assert.calledOnceWithExactly(waf.run, {
        ephemeral: {
          [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: resolverInfo,
        },
      }, {})

      sinon.assert.called(context.abortController.abort)

      const abortData = {}
      apolloChannel.asyncEnd.publish({ abortController, abortData })

      sinon.assert.calledOnceWithExactly(blocking.getBlockingData, req, 'graphql', blockParameters)

      sinon.assert.calledOnceWithExactly(rootSpan.setTag, 'appsec.blocked', 'true')
      sinon.assert.notCalled(telemetry.updateBlockFailureMetric)
    })

    it('Should catch error when block fails', () => {
      blocking.getBlockingData.returns(undefined)

      const abortController = context.abortController

      sinon.stub(waf, 'run').returns({
        actions: {
          block_request: blockParameters,
        },
      })

      sinon.stub(web, 'root').returns(rootSpan)

      startGraphqlResolver.publish({ context, resolverInfo })

      sinon.assert.calledOnceWithExactly(waf.run, {
        ephemeral: {
          [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: resolverInfo,
        },
      }, {})

      sinon.assert.calledOnce(abortController.abort)

      const abortData = {}
      apolloChannel.asyncEnd.publish({ abortController, abortData })

      sinon.assert.calledOnceWithExactly(blocking.getBlockingData, req, 'graphql', blockParameters)

      sinon.assert.calledOnceWithExactly(rootSpan.setTag, '_dd.appsec.block.failed', 1)
      sinon.assert.calledOnceWithExactly(telemetry.updateBlockFailureMetric, req)
    })
  })
})
