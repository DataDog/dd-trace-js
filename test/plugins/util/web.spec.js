'use strict'

const types = require('../../../ext/types')
const kinds = require('../../../ext/kinds')
const tags = require('../../../ext/tags')

const HTTP = types.HTTP
const SERVER = kinds.SERVER
const RESOURCE_NAME = tags.RESOURCE_NAME
const SERVICE_NAME = tags.SERVICE_NAME
const SPAN_TYPE = tags.SPAN_TYPE
const SPAN_KIND = tags.SPAN_KIND
const ERROR = tags.ERROR
const HTTP_METHOD = tags.HTTP_METHOD
const HTTP_URL = tags.HTTP_URL
const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE
const HTTP_HEADERS = tags.HTTP_HEADERS

describe('plugins/util/web', () => {
  let web
  let tracer
  let span
  let req
  let res
  let end
  let config

  beforeEach(() => {
    req = {
      headers: {
        'host': 'localhost'
      },
      connection: {}
    }
    end = sinon.stub()
    res = {
      end
    }
    config = {}

    tracer = require('../../..').init({ plugins: false })
    web = require('../../../src/plugins/util/web')
  })

  beforeEach(() => {
    config = web.normalizeConfig(config)
  })

  describe('instrument', () => {
    describe('on request start', () => {
      it('should set the parent from the request headers', () => {
        req.headers = {
          'x-datadog-trace-id': '123',
          'x-datadog-parent-id': '456'
        }

        span = web.instrument(tracer, config, req, res, 'test.request')

        expect(span.context().traceId.toString()).to.equal('123')
        expect(span.context().parentId.toString()).to.equal('456')
      })

      it('should set the service name', () => {
        config.service = 'custom'

        span = web.instrument(tracer, config, req, res, 'test.request')

        expect(span.context().tags).to.have.property(SERVICE_NAME, 'custom')
      })

      it('should activate a scope with the span', () => {
        span = web.instrument(tracer, config, req, res, 'test.request', span => {
          const scope = tracer.scopeManager().active()

          expect(scope).to.not.be.null
          expect(scope.span()).to.equal(span)
        })
      })

      it('should add request tags to the span', () => {
        req.method = 'GET'
        req.url = '/user/123'
        res.statusCode = '200'

        span = web.instrument(tracer, config, req, res, 'test.request')

        res.end()

        expect(span.context().tags).to.include({
          [SPAN_TYPE]: HTTP,
          [HTTP_URL]: 'http://localhost/user/123',
          [HTTP_METHOD]: 'GET',
          [SPAN_KIND]: SERVER
        })
      })

      it('should add configured headers to the span tags', () => {
        config.headers = ['host']

        span = web.instrument(tracer, config, req, res, 'test.request')

        res.end()

        expect(span.context().tags).to.include({
          [`${HTTP_HEADERS}.host`]: 'localhost'
        })
      })
    })

    describe('on request end', () => {
      beforeEach(() => {
        span = web.instrument(tracer, config, req, res, 'test.request')
      })

      it('should finish the span', () => {
        sinon.spy(span, 'finish')

        res.end()

        expect(span.finish).to.have.been.called
      })

      it('should should only finish once', () => {
        sinon.spy(span, 'finish')

        res.end()
        res.end()

        expect(span.finish).to.have.been.calledOnce
      })

      it('should execute any beforeEnd handlers', () => {
        const spy1 = sinon.spy()
        const spy2 = sinon.spy()

        web.beforeEnd(req, spy1)
        web.beforeEnd(req, spy2)

        res.end()

        expect(spy1).to.have.been.called
        expect(spy2).to.have.been.called
      })

      it('should call the original end', () => {
        res.end()

        expect(end).to.have.been.called
      })

      it('should add response tags to the span', () => {
        req.method = 'GET'
        req.url = '/user/123'
        res.statusCode = '200'

        res.end()

        expect(span.context().tags).to.include({
          [RESOURCE_NAME]: 'GET',
          [HTTP_STATUS_CODE]: '200'
        })
      })

      it('should set the error tag if the request is an error', () => {
        res.statusCode = 500

        res.end()

        expect(span.context().tags).to.include({
          [ERROR]: 'true'
        })
      })

      it('should set the error tag if the configured validator returns false', () => {
        config.validateStatus = () => false

        res.end()

        expect(span.context().tags).to.include({
          [ERROR]: 'true'
        })
      })
    })
  })

  describe('enterRoute', () => {
    beforeEach(() => {
      config = web.normalizeConfig(config)
      span = web.instrument(tracer, config, req, res, 'test.request')
    })

    it('should add a route segment that will be added to the span resource name', () => {
      req.method = 'GET'

      web.enterRoute(req, '/foo')
      web.enterRoute(req, '/bar')
      res.end()

      expect(span.context().tags).to.have.property([RESOURCE_NAME], 'GET /foo/bar')
    })
  })

  describe('enterRoute', () => {
    beforeEach(() => {
      config = web.normalizeConfig(config)
      span = web.instrument(tracer, config, req, res, 'test.request')
    })

    it('should remove a route segment', () => {
      req.method = 'GET'

      web.enterRoute(req, '/foo')
      web.enterRoute(req, '/bar')
      web.exitRoute(req)
      res.end()

      expect(span.context().tags).to.have.property([RESOURCE_NAME], 'GET /foo')
    })
  })

  describe('patch', () => {
    it('should patch the request with Datadog metadata', () => {
      web.patch(req)

      expect(req._datadog).to.deep.include({
        paths: [],
        beforeEnd: []
      })
    })
  })

  describe('active', () => {
    it('should return the active span', () => {
      span = web.instrument(tracer, config, req, res, 'test.request')

      expect(web.active(req)).to.equal(span)
    })

    it('should return null when not yet instrumented', () => {
      expect(web.active(req)).to.be.null
    })
  })
})
