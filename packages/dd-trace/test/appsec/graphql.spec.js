const proxyquire = require('proxyquire')
const waf = require('../../src/appsec/waf')
const web = require('../../src/plugins/util/web')
const { storage } = require('../../../datadog-core')
const addresses = require('../../src/appsec/addresses')

const {
  graphqlStartResolve,
  startGraphqlMiddleware,
  startExecuteHTTPGraphQLRequest,
  endGraphqlMiddleware,
  startGraphqlWrite
} = require('../../src/appsec/channels')

describe('GraphQL', () => {
  let graphql
  let blocking

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

    graphql = proxyquire('../../src/appsec/graphql', {
      './blocking': blocking
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
      expect(startGraphqlMiddleware.hasSubscribers).to.be.false
      expect(startExecuteHTTPGraphQLRequest.hasSubscribers).to.be.false
      expect(endGraphqlMiddleware.hasSubscribers).to.be.false
      expect(startGraphqlWrite.hasSubscribers).to.be.false
      expect(graphqlStartResolve.hasSubscribers).to.be.false

      graphql.enable()

      expect(startGraphqlMiddleware.hasSubscribers).to.be.true
      expect(startExecuteHTTPGraphQLRequest.hasSubscribers).to.be.true
      expect(endGraphqlMiddleware.hasSubscribers).to.be.true
      expect(startGraphqlWrite.hasSubscribers).to.be.true
      expect(graphqlStartResolve.hasSubscribers).to.be.true
    })
  })

  describe('disable', () => {
    it('Should unsubscribe from all channels', () => {
      graphql.enable()

      expect(startGraphqlMiddleware.hasSubscribers).to.be.true
      expect(startExecuteHTTPGraphQLRequest.hasSubscribers).to.be.true
      expect(endGraphqlMiddleware.hasSubscribers).to.be.true
      expect(startGraphqlWrite.hasSubscribers).to.be.true
      expect(graphqlStartResolve.hasSubscribers).to.be.true

      graphql.disable()

      expect(startGraphqlMiddleware.hasSubscribers).to.be.false
      expect(startExecuteHTTPGraphQLRequest.hasSubscribers).to.be.false
      expect(endGraphqlMiddleware.hasSubscribers).to.be.false
      expect(startGraphqlWrite.hasSubscribers).to.be.false
      expect(graphqlStartResolve.hasSubscribers).to.be.false
    })
  })

  describe('onGraphqlStartResolve', () => {
    beforeEach(() => {
      sinon.stub(waf, 'run').returns([''])
      sinon.stub(storage, 'getStore').returns({ req: {} })
      sinon.stub(web, 'root').returns({})
      graphql.enable()
    })

    afterEach(() => {
      sinon.restore()
      graphql.disable()
    })

    it('Should not call waf if resolvers is undefined', () => {
      const resolvers = undefined

      graphqlStartResolve.publish({ resolvers })

      expect(waf.run).not.to.have.been.called
    })

    it('Should not call waf if resolvers is not an object', () => {
      const resolvers = ''

      graphqlStartResolve.publish({ resolvers })

      expect(waf.run).not.to.have.been.called
    })

    it('Should not call waf if req is unavailable', () => {
      const resolvers = { user: [ { id: '1234' } ] }

      graphqlStartResolve.publish({ resolvers })

      expect(waf.run).not.to.have.been.called
    })

    it('Should call waf if resolvers is well formatted', () => {
      const context = {
        resolvers: {
          user: [ { id: '1234' } ]
        }
      }

      graphqlStartResolve.publish({ context })

      expect(waf.run).to.have.been.calledOnceWithExactly(
        {
          [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: context.resolvers
        },
        {}
      )
    })
  })

  describe('block response', () => {
    const req = {}
    const res = {}
    beforeEach(() => {
      sinon.stub(storage, 'getStore').returns({ req, res })

      graphql.enable()
      startGraphqlMiddleware.publish({ req, res })
      startExecuteHTTPGraphQLRequest.publish()
    })

    afterEach(() => {
      endGraphqlMiddleware.publish({ req })
      graphql.disable()
      sinon.restore()
    })

    it('Should not call abort', () => {
      const context = {
        resolvers: {
          user: [ { id: '1234' } ]
        },
        abortController: {
          abort: sinon.stub()
        }
      }

      const abortController = {}

      sinon.stub(waf, 'run').returns([''])

      graphqlStartResolve.publish({ context })

      expect(waf.run).to.have.been.calledOnceWithExactly(
        {
          [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: context.resolvers
        },
        {}
      )
      expect(context.abortController.abort).not.to.have.been.called

      startGraphqlWrite.publish({ abortController })

      expect(blocking.getBlockingData).not.to.have.been.called
    })

    it('Should call abort', () => {
      const context = {
        resolvers: {
          user: [ { id: '1234' } ]
        },
        abortController: {
          abort: sinon.stub()
        }
      }

      const abortController = context.abortController

      sinon.stub(waf, 'run').returns(['block'])
      sinon.stub(web, 'root').returns({})

      graphqlStartResolve.publish({ context })

      expect(waf.run).to.have.been.calledOnceWithExactly(
        {
          [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: context.resolvers
        },
        {}
      )
      expect(context.abortController.abort).to.have.been.called
      const abortData = {}
      startGraphqlWrite.publish({ abortController, abortData })

      expect(blocking.getBlockingData).to.have.been.calledOnceWithExactly(req, 'graphql', {})
    })
  })
})
