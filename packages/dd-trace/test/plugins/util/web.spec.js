'use strict'

const getPort = require('get-port')
const agent = require('../agent')
const types = require('../../../../../ext/types')
const kinds = require('../../../../../ext/kinds')
const tags = require('../../../../../ext/tags')
const { INCOMING_HTTP_REQUEST_START, INCOMING_HTTP_REQUEST_END } = require('../../../src/appsec/gateway/channels')

const WEB = types.WEB
const SERVER = kinds.SERVER
const RESOURCE_NAME = tags.RESOURCE_NAME
const SERVICE_NAME = tags.SERVICE_NAME
const SPAN_TYPE = tags.SPAN_TYPE
const SPAN_KIND = tags.SPAN_KIND
const ERROR = tags.ERROR
const HTTP_METHOD = tags.HTTP_METHOD
const HTTP_URL = tags.HTTP_URL
const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE
const HTTP_ROUTE = tags.HTTP_ROUTE
const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS

describe('plugins/util/web', () => {
  let web
  let tracer
  let span
  let req
  let res
  let end
  let config
  let tags

  beforeEach(() => {
    // `req` should only have common properties exposed and not things like
    // `socket` or `connection` since some libraries rely on fake objects that
    // may not have those.
    req = {
      method: 'GET',
      headers: {
        'host': 'localhost',
        'date': 'now'
      }
    }
    end = sinon.stub()
    res = {
      end,
      getHeader: sinon.stub(),
      getHeaders: sinon.stub().returns({}),
      setHeader: sinon.spy(),
      writeHead: () => {}
    }
    res.getHeader.withArgs('server').returns('test')
    config = { hooks: {} }

    tracer = require('../../..').init({ plugins: false })
    web = require('../../../src/plugins/util/web')
  })

  beforeEach(() => {
    config = web.normalizeConfig(config)
  })

  describe('normalizeConfig', () => {
    it('should set the correct defaults', () => {
      const config = web.normalizeConfig({})

      expect(config).to.have.property('headers')
      expect(config.headers).to.be.an('array')
      expect(config).to.have.property('validateStatus')
      expect(config.validateStatus).to.be.a('function')
      expect(config.validateStatus(200)).to.equal(true)
      expect(config.validateStatus(500)).to.equal(false)
      expect(config).to.have.property('hooks')
      expect(config.hooks).to.be.an('object')
      expect(config.hooks).to.have.property('request')
      expect(config.hooks.request).to.be.a('function')
    })

    it('should use the shared config if set', () => {
      const config = web.normalizeConfig({
        headers: ['test'],
        validateStatus: code => false,
        hooks: {
          request: () => 'test'
        }
      })

      expect(config.headers).to.include('test')
      expect(config.validateStatus(200)).to.equal(false)
      expect(config).to.have.property('hooks')
      expect(config.hooks.request()).to.equal('test')
    })

    it('should use the server config if set', () => {
      const config = web.normalizeConfig({
        server: {
          headers: ['test'],
          validateStatus: code => false,
          hooks: {
            request: () => 'test'
          }
        }
      })

      expect(config.headers).to.include('test')
      expect(config.validateStatus(200)).to.equal(false)
      expect(config).to.have.property('hooks')
      expect(config.hooks.request()).to.equal('test')
    })

    it('should prioritize the server config over the shared config', () => {
      const config = web.normalizeConfig({
        headers: ['foo'],
        server: {
          headers: ['bar']
        }
      })

      expect(config.headers).to.include('bar')
    })
  })

  describe('instrument', () => {
    describe('on request start', () => {
      it('should set the parent from the request headers', () => {
        req.headers = {
          'x-datadog-trace-id': '123',
          'x-datadog-parent-id': '456'
        }

        web.instrument(tracer, config, req, res, 'test.request', span => {
          expect(span.context()._traceId.toString(10)).to.equal('123')
          expect(span.context()._parentId.toString(10)).to.equal('456')
        })
      })

      it('should set the parent from the active context if any', () => {
        tracer.trace('aws.lambda', parentSpan => {
          web.instrument(tracer, config, req, res, 'test.request', span => {
            expect(span.context()._traceId.toString(10)).to.equal(parentSpan.context()._traceId.toString(10))
            expect(span.context()._parentId.toString(10)).to.equal(parentSpan.context()._spanId.toString(10))
          })
        })
      })

      it('should set the service name', () => {
        config.service = 'custom'

        web.instrument(tracer, config, req, res, 'test.request', span => {
          expect(span.context()._tags).to.have.property(SERVICE_NAME, 'custom')
        })
      })

      it('should activate a scope with the span', () => {
        web.instrument(tracer, config, req, res, 'test.request', span => {
          expect(tracer.scope().active()).to.equal(span)
        })
      })

      it('should add request tags to the span', () => {
        req.method = 'GET'
        req.url = '/user/123'
        res.statusCode = '200'

        web.instrument(tracer, config, req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.include({
            [SPAN_TYPE]: WEB,
            [HTTP_URL]: 'http://localhost/user/123',
            [HTTP_METHOD]: 'GET',
            [SPAN_KIND]: SERVER
          })
        })
      })

      it('should add configured headers to the span tags', () => {
        config.headers = ['host', 'server']

        web.instrument(tracer, config, req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.include({
            [`${HTTP_REQUEST_HEADERS}.host`]: 'localhost',
            [`${HTTP_RESPONSE_HEADERS}.server`]: 'test'
          })
        })
      })

      it('should only start one span for the entire request', () => {
        web.instrument(tracer, config, req, res, 'test.request', span1 => {
          web.instrument(tracer, config, req, res, 'test.request', span2 => {
            expect(span1).to.equal(span2)
          })
        })
      })

      it('should allow overriding the span name', () => {
        web.instrument(tracer, config, req, res, 'test.request', () => {
          web.instrument(tracer, config, req, res, 'test2.request', span => {
            expect(span.context()._name).to.equal('test2.request')
          })
        })
      })

      it('should allow overriding the span service name', () => {
        web.instrument(tracer, config, req, res, 'test.request', span => {
          config.service = 'test2'
          web.instrument(tracer, config, req, res, 'test.request')

          expect(span.context()._tags).to.have.property('service.name', 'test2')
        })
      })

      it('should only wrap res.end once', () => {
        web.instrument(tracer, config, req, res, 'test.request')
        const end = res.end
        web.instrument(tracer, config, req, res, 'test.request')

        expect(end).to.equal(res.end)
      })

      it('should use the config from the last call', () => {
        config.headers = ['host']

        const override = web.normalizeConfig({
          headers: ['date']
        })

        web.instrument(tracer, config, req, res, 'test.request', () => {
          web.instrument(tracer, override, req, res, 'test.request', span => {
            const tags = span.context()._tags

            res.end()

            expect(tags).to.include({
              [`${HTTP_REQUEST_HEADERS}.date`]: 'now'
            })
          })
        })
      })

      it('should remove the query string from the URL', () => {
        req.method = 'GET'
        req.url = '/user/123?foo=bar'
        res.statusCode = '200'

        web.instrument(tracer, config, req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.include({
            [HTTP_URL]: 'http://localhost/user/123'
          })
        })
      })

      it('should handle CORS preflight', () => {
        const headers = [
          'x-datadog-origin',
          'x-datadog-parent-id',
          'x-datadog-sampled',
          'x-datadog-sampling-priority',
          'x-datadog-trace-id'
        ].join(',')

        req.method = 'OPTIONS'
        req.headers['origin'] = 'http://test.com'
        req.headers['access-control-request-headers'] = headers

        res.getHeaders.returns({
          'access-control-allow-origin': 'http://test.com'
        })

        web.instrument(tracer, config, req, res, 'test.request')

        res.writeHead()

        expect(res.setHeader).to.have.been.calledWith('access-control-allow-headers', headers)
      })

      it('should handle CORS preflight with partial headers', () => {
        const headers = [
          'x-datadog-parent-id',
          'x-datadog-trace-id'
        ].join(',')

        req.method = 'OPTIONS'
        req.headers['origin'] = 'http://test.com'
        req.headers['access-control-request-headers'] = headers

        res.getHeaders.returns({
          'access-control-allow-origin': 'http://test.com'
        })

        web.instrument(tracer, config, req, res, 'test.request')

        res.writeHead()

        expect(res.setHeader).to.have.been.calledWith('access-control-allow-headers', headers)
      })

      it('should handle CORS preflight when the origin does not match', () => {
        const headers = ['x-datadog-trace-id']

        req.method = 'OPTIONS'
        req.headers['origin'] = 'http://test.com'
        req.headers['access-control-request-headers'] = headers

        web.instrument(tracer, config, req, res, 'test.request')

        res.writeHead()

        expect(res.setHeader).to.not.have.been.called
      })

      it('should handle CORS preflight when no header was requested', () => {
        req.method = 'OPTIONS'
        req.headers['origin'] = 'http://test.com'

        res.getHeaders.returns({
          'access-control-allow-origin': 'http://test.com'
        })

        web.instrument(tracer, config, req, res, 'test.request')

        res.writeHead()

        expect(res.setHeader).to.not.have.been.called
      })

      it('should support https', () => {
        req.url = '/user/123'
        req.socket = { encrypted: true }

        web.instrument(tracer, config, req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.include({
            [SPAN_TYPE]: WEB,
            [HTTP_URL]: 'https://localhost/user/123',
            [HTTP_METHOD]: 'GET',
            [SPAN_KIND]: SERVER
          })
        })
      })

      it('should support HTTP2 compatibility API', () => {
        req.stream = {}
        req.method = 'GET'
        req.headers = {
          ':scheme': 'https',
          ':authority': 'localhost',
          ':method': 'GET',
          ':path': '/user/123'
        }
        res.statusCode = '200'

        web.instrument(tracer, config, req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.include({
            [SPAN_TYPE]: WEB,
            [HTTP_URL]: 'https://localhost/user/123',
            [HTTP_METHOD]: 'GET',
            [SPAN_KIND]: SERVER
          })
        })
      })

      it('should call diagnostics_channel', () => {
        const spy = sinon.spy((data) => {
          expect(data.req).to.equal(req)
          expect(data.res).to.equal(res)
          expect(tracer.scope().active()).to.exist
        })

        INCOMING_HTTP_REQUEST_START.subscribe(spy)

        web.instrument(tracer, config, req, res, 'test.request', span => {
          expect(spy).to.have.been.calledOnce

          expect(tracer.scope().active()).to.equal(span)
        })

        INCOMING_HTTP_REQUEST_START.unsubscribe(spy)
      })

      it('should call diagnostics_channel even without callback', () => {
        const spy = sinon.spy((data) => {
          expect(data.req).to.equal(req)
          expect(data.res).to.equal(res)
          expect(tracer.scope().active()).to.not.exist
        })

        INCOMING_HTTP_REQUEST_START.subscribe(spy)

        web.instrument(tracer, config, req, res, 'test.request')

        INCOMING_HTTP_REQUEST_START.unsubscribe(spy)

        expect(spy).to.have.been.calledOnce
      })
    })

    describe('on request end', () => {
      beforeEach(() => {
        web.instrument(tracer, config, req, res, 'test.request', reqSpan => {
          span = reqSpan
          tags = span.context()._tags
        })
      })

      it('should finish the request span', () => {
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

      it('should finish middleware spans', () => {
        web.wrapMiddleware(req, () => {}, 'middleware', () => {
          const span = tracer.scope().active()

          sinon.spy(span, 'finish')

          res.end()

          expect(span.finish).to.have.been.called
        })
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
        res.statusCode = 200

        res.end()

        expect(tags).to.include({
          [RESOURCE_NAME]: 'GET',
          [HTTP_STATUS_CODE]: 200
        })
      })

      it('should set the error tag if the request is an error', () => {
        res.statusCode = 500

        res.end()

        expect(tags).to.include({
          [ERROR]: true
        })
      })

      it('should set the error tag if the configured validator returns false', () => {
        config.validateStatus = () => false

        res.end()

        expect(tags).to.include({
          [ERROR]: true
        })
      })

      it('should use the user provided route', () => {
        span.setTag('http.route', '/custom/route')

        res.end()

        expect(tags).to.include({
          [HTTP_ROUTE]: '/custom/route'
        })
      })

      it('should execute the request end hook', () => {
        config.hooks.request = sinon.spy()

        res.end()

        expect(config.hooks.request).to.have.been.calledWith(span, req, res)
      })

      it('should execute multiple end hooks', () => {
        config.hooks = {
          request: sinon.spy()
        }

        web.instrument(tracer, config, req, res, 'test.request', span => {
          res.end()

          expect(config.hooks.request).to.have.been.calledWith(span, req, res)
        })
      })

      it('should set the resource name from the http.route tag set in the hooks', () => {
        config.hooks = {
          request: span => span.setTag('http.route', '/custom/route')
        }

        web.instrument(tracer, config, req, res, 'test.request', span => {
          res.end()

          expect(tags).to.have.property('resource.name', 'GET /custom/route')
        })
      })

      it('should call diagnostics_channel', () => {
        sinon.spy(span, 'finish')

        const spy = sinon.spy((data) => {
          expect(data.req).to.equal(req)
          expect(data.res).to.equal(res)
          expect(tracer.scope().active()).to.not.exist
        })

        INCOMING_HTTP_REQUEST_END.subscribe(spy)

        res.end()

        INCOMING_HTTP_REQUEST_END.unsubscribe(spy)

        expect(span.finish).to.have.been.calledOnce

        expect(spy).to.have.been.calledOnce
      })
    })
  })

  describe('enterRoute', () => {
    beforeEach(() => {
      config = web.normalizeConfig(config)
      web.instrument(tracer, config, req, res, 'test.request', () => {
        span = tracer.scope().active()
        tags = span.context()._tags
      })
    })

    it('should add a route segment that will be added to the span resource name', () => {
      req.method = 'GET'

      web.enterRoute(req, '/foo')
      web.enterRoute(req, '/bar')
      res.end()

      expect(tags).to.have.property(RESOURCE_NAME, 'GET /foo/bar')
      expect(tags).to.have.property(HTTP_ROUTE, '/foo/bar')
    })

    it('should only add valid route segments to the span resource name', () => {
      req.method = 'GET'

      web.enterRoute(req)
      web.enterRoute(req, 1337)
      res.end()

      expect(tags).to.have.property(RESOURCE_NAME, 'GET')
      expect(tags).to.not.have.property(HTTP_ROUTE)
    })
  })

  describe('exitRoute', () => {
    beforeEach(() => {
      config = web.normalizeConfig(config)
      web.instrument(tracer, config, req, res, 'test.request', reqSpan => {
        span = reqSpan
        tags = span.context()._tags
      })
    })

    it('should remove a route segment', () => {
      req.method = 'GET'

      web.enterRoute(req, '/foo')
      web.enterRoute(req, '/bar')
      web.exitRoute(req)
      res.end()

      expect(tags).to.have.property(RESOURCE_NAME, 'GET /foo')
    })
  })

  describe('wrapMiddleware', () => {
    beforeEach(() => {
      config = web.normalizeConfig(config)
      web.instrument(tracer, config, req, res, 'test.request', () => {
        span = tracer.scope().active()
        tags = span.context()._tags
      })
    })

    it('should activate a scope with the span', (done) => {
      const fn = function test () {
        expect(tracer.scope().active()).to.not.equal(span)
        done()
      }

      web.wrapMiddleware(req, fn, 'middleware', () => fn(req, res))
    })
  })

  describe('finish', () => {
    beforeEach(() => {
      config = web.normalizeConfig(config)
      web.instrument(tracer, config, req, res, 'test.request', () => {
        span = tracer.scope().active()
        tags = span.context()._tags
      })
    })

    it('should finish the span of the current middleware', (done) => {
      const fn = () => {
        const span = tracer.scope().active()

        sinon.spy(span, 'finish')
        web.finish(req, fn, 'middleware')

        expect(span.finish).to.have.been.called

        done()
      }

      web.wrapMiddleware(req, fn, 'middleware', () => fn(req, res))
    })

    it('should add an error if provided', (done) => {
      const fn = () => {
        const span = tracer.scope().active()
        const tags = span.context()._tags
        const error = new Error('boom')

        sinon.spy(span, 'finish')
        web.finish(req, error)

        expect(tags['error.type']).to.equal(error.name)
        expect(tags['error.msg']).to.equal(error.message)
        expect(tags['error.stack']).to.equal(error.stack)

        done()
      }

      web.wrapMiddleware(req, fn, 'middleware', () => fn(req, res))
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

  describe('root', () => {
    it('should return the request root span', () => {
      web.instrument(tracer, config, req, res, 'test.request', () => {
        const span = tracer.scope().active()

        web.wrapMiddleware(req, () => {}, 'express.middleware', () => {
          expect(web.root(req)).to.equal(span)
        })
      })
    })

    it('should return null when not yet instrumented', () => {
      expect(web.root(req)).to.be.null
    })
  })

  describe('active', () => {
    it('should return the request span by default', () => {
      web.instrument(tracer, config, req, res, 'test.request', () => {
        expect(web.active(req)).to.equal(tracer.scope().active())
      })
    })

    it('should return the active middleware span', () => {
      web.instrument(tracer, config, req, res, 'test.request', () => {
        const span = tracer.scope().active()

        web.wrapMiddleware(req, () => {}, 'express.middleware', () => {
          expect(web.active(req)).to.not.be.null
          expect(web.active(req)).to.not.equal(span)
        })
      })
    })

    it('should return null when not yet instrumented', () => {
      expect(web.active(req)).to.be.null
    })
  })

  describe('addError', () => {
    beforeEach(() => {
      config = web.normalizeConfig(config)
      web.instrument(tracer, config, req, res, 'test.request', () => {
        span = tracer.scope().active()
        tags = span.context()._tags
      })
    })

    it('should add an error to the request span', () => {
      const error = new Error('boom')

      web.addError(req, error)
      web.addStatusError(req, 500)

      expect(tags).to.include({
        [ERROR]: error
      })
    })

    it('should not override an existing error', () => {
      const error = new Error('boom')

      web.addError(req, error)
      web.addError(req, new Error('prrr'))
      web.addStatusError(req, 500)

      expect(tags).to.include({
        [ERROR]: error
      })
    })
  })

  describe('addStatusError', () => {
    beforeEach(() => {
      config = web.normalizeConfig(config)
      web.instrument(tracer, config, req, res, 'test.request', () => {
        span = tracer.scope().active()
        tags = span.context()._tags
      })
    })

    it('should flag the request as an error', () => {
      web.addStatusError(req, 500)

      expect(tags).to.include({
        [ERROR]: true
      })
    })

    it('should only flag requests as an error for configured status codes', () => {
      config.validateStatus = () => true

      web.addStatusError(req, 500)

      expect(tags).to.not.have.property(ERROR)
    })
  })

  describe('with an instrumented web server', done => {
    let express
    let app
    let port
    let server
    let http

    beforeEach(done => {
      agent.load('express')
        .then(getPort)
        .then(_port => {
          port = _port
          http = require('http')
          express = require('express')
          app = express()

          server = app.listen(port, '127.0.0.1', () => done())
        })
    })

    afterEach(done => {
      agent.close().then(() => {
        server.close(() => done())
      })
    })

    it('should run res.end handlers in the request scope', done => {
      let handler

      const interval = setInterval(() => {
        if (handler) {
          handler()
          clearInterval(interval)
        }
      })

      app.use((req, res) => {
        const end = res.end

        res.end = function () {
          end.apply(this, arguments)

          try {
            expect(tracer.scope().active()).to.not.be.null
            done()
          } catch (e) {
            done(e)
          }
        }

        handler = () => res.status(200).send()
      })

      const req = http.get(`http://127.0.0.1:${port}`)
      req.on('error', done)
    })

    it('should run res.end handlers in the request scope for clones', done => {
      let handler

      const interval = setInterval(() => {
        if (handler) {
          handler()
          clearInterval(interval)
        }
      })

      app.use((req, res) => {
        const clone = Object.create(res)

        clone.end = function () {
          res.end.apply(this, arguments)

          try {
            expect(tracer.scope().active()).to.not.be.null
            done()
          } catch (e) {
            done(e)
          }
        }

        handler = () => clone.end()
      })

      const req = http.get(`http://127.0.0.1:${port}`)
      req.on('error', done)
    })

    it('should run "finish" event handlers in the request scope', done => {
      app.use((req, res, next) => {
        res.on('finish', () => {
          try {
            expect(tracer.scope().active()).to.not.be.null
            done()
          } catch (e) {
            done(e)
          }
        })

        res.status(200).send()
      })

      const req = http.get(`http://127.0.0.1:${port}`)
      req.on('error', done)
    })

    it('should run "close" event handlers in the request scope', done => {
      const sockets = []

      app.use((req, res, next) => {
        res.on('close', () => {
          try {
            expect(tracer.scope().active()).to.not.be.null
            done()
          } catch (e) {
            done(e)
          }
        })

        sockets.forEach(socket => socket.destroy())
      })

      server.on('connection', (socket) => {
        sockets.push(socket)
      })

      const req = http.get(`http://127.0.0.1:${port}`)
      req.on('error', () => {})
    })
  })

  describe('allowlistFilter', () => {
    beforeEach(() => {
      config = { allowlist: ['/_okay'] }
      config = web.normalizeConfig(config)
    })

    it('should not filter the url', () => {
      const filtered = config.filter('/_okay')
      expect(filtered).to.equal(true)
    })

    it('should filter the url', () => {
      const filtered = config.filter('/_notokay')
      expect(filtered).to.equal(false)
    })
  })

  describe('whitelistFilter', () => {
    beforeEach(() => {
      config = { whitelist: ['/_okay'] }
      config = web.normalizeConfig(config)
    })

    it('should not filter the url', () => {
      const filtered = config.filter('/_okay')
      expect(filtered).to.equal(true)
    })

    it('should filter the url', () => {
      const filtered = config.filter('/_notokay')
      expect(filtered).to.equal(false)
    })
  })

  describe('blocklistFilter', () => {
    beforeEach(() => {
      config = { blocklist: ['/_notokay'] }
      config = web.normalizeConfig(config)
    })

    it('should not filter the url', () => {
      const filtered = config.filter('/_okay')
      expect(filtered).to.equal(true)
    })

    it('should filter the url', () => {
      const filtered = config.filter('/_notokay')
      expect(filtered).to.equal(false)
    })
  })

  describe('blacklistFilter', () => {
    beforeEach(() => {
      config = { blacklist: ['/_notokay'] }
      config = web.normalizeConfig(config)
    })

    it('should not filter the url', () => {
      const filtered = config.filter('/_okay')
      expect(filtered).to.equal(true)
    })

    it('should filter the url', () => {
      const filtered = config.filter('/_notokay')
      expect(filtered).to.equal(false)
    })
  })
})
