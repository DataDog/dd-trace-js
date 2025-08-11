'use strict'

const types = require('../../../ext/types')
const kinds = require('../../../ext/kinds')
const tags = require('../../../ext/tags')
const { USER_REJECT } = require('../../../ext/priority')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

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
const HTTP_USERAGENT = tags.HTTP_USERAGENT
const HTTP_CLIENT_IP = tags.HTTP_CLIENT_IP

describe('Plugin', () => {
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
        host: 'localhost',
        date: 'now'
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
    const WebPlugin = require('../src')
    web = new WebPlugin(tracer, config)
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
      expect(config).to.have.property('queryStringObfuscation', true)
    })

    it('should use the shared config if set', () => {
      const config = web.normalizeConfig({
        headers: ['test'],
        validateStatus: code => false,
        hooks: {
          request: () => 'test'
        }
      })

      expect(config.headers).to.deep.equal([['test', undefined]])
      expect(config.validateStatus(200)).to.equal(false)
      expect(config).to.have.property('hooks')
      expect(config.hooks.request()).to.equal('test')
    })

    describe('queryStringObfuscation', () => {
      it('should keep booleans as is', () => {
        const config = web.normalizeConfig({
          queryStringObfuscation: false
        })

        expect(config).to.have.property('queryStringObfuscation', false)
      })

      it('should change to false when passed empty string', () => {
        const config = web.normalizeConfig({
          queryStringObfuscation: ''
        })

        expect(config).to.have.property('queryStringObfuscation', false)
      })

      it('should change to true when passed ".*"', () => {
        const config = web.normalizeConfig({
          queryStringObfuscation: '.*'
        })

        expect(config).to.have.property('queryStringObfuscation', true)
      })

      it('should convert to regex when passed valid string', () => {
        const config = web.normalizeConfig({
          queryStringObfuscation: 'a*'
        })

        expect(config).to.have.deep.property('queryStringObfuscation', /a*/gi)
      })

      it('should default to true when passed a bad regex', () => {
        const config = web.normalizeConfig({
          queryStringObfuscation: '(?)'
        })

        expect(config).to.have.property('queryStringObfuscation', true)
      })
    })
  })

  describe('instrument', () => {
    describe('on request start', () => {
      it('should set the parent from the request headers', () => {
        req.headers = {
          'x-datadog-trace-id': '123',
          'x-datadog-parent-id': '456'
        }

        web.instrument(req, res, 'test.request', span => {
          expect(span.context()._traceId.toString(10)).to.equal('123')
          expect(span.context()._parentId.toString(10)).to.equal('456')
        })
      })

      it('should set the service name', () => {
        web.configure({ service: 'custom' })

        web.instrument(req, res, 'test.request', span => {
          expect(span.context()._tags).to.have.property(SERVICE_NAME, 'custom')
        })
      })

      it('should activate a scope with the span', () => {
        web.instrument(req, res, 'test.request', span => {
          expect(tracer.scope().active()).to.equal(span)
        })
      })

      it('should add request tags to the span', () => {
        req.method = 'GET'
        req.url = '/user/123'
        req.headers['user-agent'] = 'curl'
        req.headers['x-forwarded-for'] = '8.8.8.8'
        res.statusCode = '200'

        web.instrument(req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.include({
            [SPAN_TYPE]: WEB,
            [HTTP_URL]: 'http://localhost/user/123',
            [HTTP_METHOD]: 'GET',
            [SPAN_KIND]: SERVER,
            [HTTP_USERAGENT]: 'curl'
          })
        })
      })

      it('should add client ip tag to the span when enabled', () => {
        req.headers['x-forwarded-for'] = '8.8.8.8'

        web.configure({ clientIpEnabled: true })

        web.instrument(req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.include({
            [HTTP_CLIENT_IP]: '8.8.8.8'
          })
        })
      })

      it('should add custom client ip tag to the span when it is configured', () => {
        req.headers['X-Forwad-For'] = '8.8.8.8'

        web.configure({ clientIpEnabled: true, clientIpHeader: 'X-Forwad-For' })

        web.instrument(req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.include({
            [HTTP_CLIENT_IP]: '8.8.8.8'
          })
        })
      })

      it('should not add custom client ip tag to the span when it is not configured', () => {
        req.headers['X-Forwad-For'] = '8.8.8.8'

        web.configure({ clientIpEnabled: true })

        web.instrument(req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.not.have.property(HTTP_CLIENT_IP)
        })
      })

      it('should not add client ip tag to the span when disabled', () => {
        req.headers['x-forwarded-for'] = '8.8.8.8'

        web.configure({ clientIpEnabled: false })

        web.instrument(req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.not.have.property(HTTP_CLIENT_IP)
        })
      })

      it('should not replace client ip when it exists', () => {
        req.headers['x-forwarded-for'] = '8.8.8.8'

        web.configure({ clientIpEnabled: true })

        web.instrument(req, res, 'test.request', span => {
          const tags = span.context()._tags

          span.setTag(HTTP_CLIENT_IP, '1.1.1.1')

          res.end()

          expect(tags).to.include({
            [HTTP_CLIENT_IP]: '1.1.1.1'
          })
        })
      })

      it('should not add client ip tag when no candidate header is present in request', () => {
        web.configure({ clientIpEnabled: true })

        web.instrument(req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.not.have.property(HTTP_CLIENT_IP)
        })
      })

      it('should add configured headers to the span tags', () => {
        req.headers.req = 'incoming'
        req.headers.res = 'outgoing'

        web.configure({ headers: ['host', 'req:http.req', 'server', 'res:http.res'] })

        web.instrument(req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.include({
            [`${HTTP_REQUEST_HEADERS}.host`]: 'localhost',
            'http.req': 'incoming',
            [`${HTTP_RESPONSE_HEADERS}.server`]: 'test',
            'http.res': 'outgoing'
          })
        })
      })

      it('should only start one span for the entire request', () => {
        web.instrument(req, res, 'test.request', span1 => {
          web.instrument(req, res, 'test.request', span2 => {
            expect(span1).to.equal(span2)
          })
        })
      })

      it('should allow overriding the span name', () => {
        web.instrument(req, res, 'test.request', () => {
          web.instrument(req, res, 'test2.request', span => {
            expect(span.context()._name).to.equal('test2.request')
          })
        })
      })

      it('should allow overriding the span service name', () => {
        web.instrument(req, res, 'test.request', span => {
          web.configure({ service: 'test2' })
          web.instrument(req, res, 'test.request')

          expect(span.context()._tags).to.have.property('service.name', 'test2')
        })
      })

      it('should only wrap res.end once', () => {
        web.instrument(req, res, 'test.request')
        const end = res.end
        web.instrument(req, res, 'test.request')

        expect(end).to.equal(res.end)
      })

      it('should use the config from the last call', () => {
        web.configure({ headers: ['host'] })

        web.instrument(req, res, 'test.request', () => {
          web.configure({ headers: ['date'] })
          web.instrument(req, res, 'test.request', span => {
            const tags = span.context()._tags

            res.end()

            expect(tags).to.include({
              [`${HTTP_REQUEST_HEADERS}.date`]: 'now'
            })
          })
        })
      })

      it('should obfuscate the query string from the URL', () => {
        web.configure({ queryStringObfuscation: 'secret=.*?(&|$)' })

        req.method = 'GET'
        req.url = '/user/123?secret=password&foo=bar'
        res.statusCode = '200'

        web.instrument(req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.include({
            [HTTP_URL]: 'http://localhost/user/123?<redacted>foo=bar'
          })
        })
      })

      it('should handle CORS preflight', () => {
        const headers = [
          'x-datadog-origin',
          'x-datadog-parent-id',
          'x-datadog-sampled',
          'x-datadog-sampling-priority',
          'x-datadog-trace-id',
          'x-datadog-tags'
        ].join(',')

        req.method = 'OPTIONS'
        req.headers.origin = 'http://test.com'
        req.headers['access-control-request-headers'] = headers

        res.getHeaders.returns({
          'access-control-allow-origin': 'http://test.com'
        })

        web.instrument(req, res, 'test.request')

        res.writeHead()

        expect(res.setHeader).to.have.been.calledWith('access-control-allow-headers', headers)
      })

      it('should handle CORS preflight with partial headers', () => {
        const headers = [
          'x-datadog-parent-id',
          'x-datadog-trace-id'
        ].join(',')

        req.method = 'OPTIONS'
        req.headers.origin = 'http://test.com'
        req.headers['access-control-request-headers'] = headers

        res.getHeaders.returns({
          'access-control-allow-origin': 'http://test.com'
        })

        web.instrument(req, res, 'test.request')

        res.writeHead()

        expect(res.setHeader).to.have.been.calledWith('access-control-allow-headers', headers)
      })

      it('should handle CORS preflight when the origin does not match', () => {
        const headers = ['x-datadog-trace-id']

        req.method = 'OPTIONS'
        req.headers.origin = 'http://test.com'
        req.headers['access-control-request-headers'] = headers

        web.instrument(req, res, 'test.request')

        res.writeHead()

        expect(res.setHeader).to.not.have.been.called
      })

      it('should handle CORS preflight when no header was requested', () => {
        req.method = 'OPTIONS'
        req.headers.origin = 'http://test.com'

        res.getHeaders.returns({
          'access-control-allow-origin': 'http://test.com'
        })

        web.instrument(req, res, 'test.request')

        res.writeHead()

        expect(res.setHeader).to.not.have.been.called
      })

      it('should support https', () => {
        req.url = '/user/123'
        req.headers['user-agent'] = 'curl'
        req.headers['x-forwarded-for'] = '8.8.8.8'
        req.socket = { encrypted: true }

        web.instrument(req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.include({
            [SPAN_TYPE]: WEB,
            [HTTP_URL]: 'https://localhost/user/123',
            [HTTP_METHOD]: 'GET',
            [SPAN_KIND]: SERVER,
            [HTTP_USERAGENT]: 'curl'
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
          ':path': '/user/123',
          'user-agent': 'curl',
          'x-forwarded-for': '8.8.8.8'
        }
        res.statusCode = '200'

        web.instrument(req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.include({
            [SPAN_TYPE]: WEB,
            [HTTP_URL]: 'https://localhost/user/123',
            [HTTP_METHOD]: 'GET',
            [SPAN_KIND]: SERVER,
            [HTTP_USERAGENT]: 'curl'
          })
        })
      })

      it('should drop filtered out requests', () => {
        web.configure({ filter: () => false })

        web.instrument(req, res, 'test.request', span => {
          const sampling = span.context()._sampling

          res.end()

          expect(sampling).to.have.property('priority', USER_REJECT)
        })
      })
    })

    describe('on request end', () => {
      beforeEach(() => {
        web.instrument(req, res, 'test.request', reqSpan => {
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
        web.configure({ validateStatus: () => false })

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
        const hook = sinon.spy()

        web.configure({ hooks: { request: hook } })

        res.end()

        expect(hook).to.have.been.calledWith(span, req, res)
      })

      it('should execute multiple end hooks', () => {
        const hook = sinon.spy()
        web.configure({ hooks: { request: hook } })

        web.instrument(req, res, 'test.request', span => {
          res.end()

          expect(hook).to.have.been.calledWith(span, req, res)
        })
      })

      it('should set the resource name from the http.route tag set in the hooks', () => {
        web.configure({
          hooks: {
            request: span => span.setTag('http.route', '/custom/route')
          }
        })

        web.instrument(req, res, 'test.request', span => {
          res.end()

          expect(tags).to.have.property('resource.name', 'GET /custom/route')
        })
      })
    })
  })

  describe('enterRoute', () => {
    beforeEach(() => {
      web.instrument(req, res, 'test.request', () => {
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
      web.instrument(req, res, 'test.request', reqSpan => {
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
      web.instrument(req, res, 'test.request', () => {
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
      web.instrument(req, res, 'test.request', () => {
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

        expect(tags[ERROR_TYPE]).to.equal(error.name)
        expect(tags[ERROR_MESSAGE]).to.equal(error.message)
        expect(tags[ERROR_STACK]).to.equal(error.stack)

        done()
      }

      web.wrapMiddleware(req, fn, 'middleware', () => fn(req, res))
    })
  })

  describe('root', () => {
    it('should return the request root span', () => {
      web.instrument(req, res, 'test.request', () => {
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
      web.instrument(req, res, 'test.request', () => {
        expect(web.active(req)).to.equal(tracer.scope().active())
      })
    })

    it('should return the active middleware span', () => {
      web.instrument(req, res, 'test.request', () => {
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
      web.instrument(req, res, 'test.request', () => {
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

    it('should override an existing error', () => {
      const error = new Error('boom')

      web.addError(req, new Error('prrr'))
      web.addError(req, error)
      web.addStatusError(req, 500)

      expect(tags).to.include({
        [ERROR]: error
      })
    })
  })

  describe('addStatusError', () => {
    beforeEach(() => {
      web.instrument(req, res, 'test.request', () => {
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
      web.configure({ validateStatus: () => true })

      web.addStatusError(req, 500)

      expect(tags).to.not.have.property(ERROR)
    })
  })

  describe('allowlistFilter', () => {
    beforeEach(() => {
      web.configure({ allowlist: ['/_okay'] })
    })

    it('should not filter the url', () => {
      const filtered = web.config.filter('/_okay')
      expect(filtered).to.equal(true)
    })

    it('should filter the url', () => {
      const filtered = web.config.filter('/_notokay')
      expect(filtered).to.equal(false)
    })
  })

  describe('whitelistFilter', () => {
    beforeEach(() => {
      web.configure({ whitelist: ['/_okay'] })
    })

    it('should not filter the url', () => {
      const filtered = web.config.filter('/_okay')
      expect(filtered).to.equal(true)
    })

    it('should filter the url', () => {
      const filtered = web.config.filter('/_notokay')
      expect(filtered).to.equal(false)
    })
  })

  describe('blocklistFilter', () => {
    beforeEach(() => {
      web.configure({ blocklist: ['/_notokay'] })
    })

    it('should not filter the url', () => {
      const filtered = web.config.filter('/_okay')
      expect(filtered).to.equal(true)
    })

    it('should filter the url', () => {
      const filtered = web.config.filter('/_notokay')
      expect(filtered).to.equal(false)
    })
  })

  describe('blacklistFilter', () => {
    beforeEach(() => {
      web.configure({ blacklist: ['/_notokay'] })
    })

    it('should not filter the url', () => {
      const filtered = web.config.filter('/_okay')
      expect(filtered).to.equal(true)
    })

    it('should filter the url', () => {
      const filtered = web.config.filter('/_notokay')
      expect(filtered).to.equal(false)
    })
  })

  describe('obfuscateQs', () => {
    const url = 'http://perdu.com/path/'
    const qs = '?data=secret'

    beforeEach(() => {
      web.configure({
        queryStringObfuscation: /secret/gi
      })
    })

    it('should not obfuscate when passed false', () => {
      web.configure({ queryStringObfuscation: false })

      const result = web._obfuscateQs(url + qs)

      expect(result).to.equal(url + qs)
    })

    it('should not obfuscate when no querystring is found', () => {
      const result = web._obfuscateQs(url)

      expect(result).to.equal(url)
    })

    it('should remove the querystring if passed true', () => {
      web.configure({ queryStringObfuscation: true })

      const result = web._obfuscateQs(url + qs, web.config)

      expect(result).to.equal(url)
    })

    it('should obfuscate only the querystring part of the url', () => {
      const result = web._obfuscateQs(url + 'secret/' + qs, web.config)

      expect(result).to.equal(url + 'secret/?data=<redacted>')
    })
  })
})
