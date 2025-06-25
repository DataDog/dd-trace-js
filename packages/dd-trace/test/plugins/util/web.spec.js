'use strict'

const t = require('tap')
require('../../setup/core')

const types = require('../../../../../ext/types')
const kinds = require('../../../../../ext/kinds')
const tags = require('../../../../../ext/tags')
const { USER_REJECT } = require('../../../../../ext/priority')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../../../dd-trace/src/constants')

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

t.test('plugins/util/web', t => {
  let web
  let tracer
  let span
  let req
  let res
  let end
  let config
  let tags

  t.beforeEach(() => {
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
    web = require('../../../src/plugins/util/web')
  })

  t.beforeEach(() => {
    config = web.normalizeConfig(config)
  })

  t.test('normalizeConfig', t => {
    t.test('should set the correct defaults', t => {
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
      t.end()
    })

    t.test('should use the shared config if set', t => {
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
      t.end()
    })

    t.test('queryStringObfuscation', t => {
      t.test('should keep booleans as is', t => {
        const config = web.normalizeConfig({
          queryStringObfuscation: false
        })

        expect(config).to.have.property('queryStringObfuscation', false)
        t.end()
      })

      t.test('should change to false when passed empty string', t => {
        const config = web.normalizeConfig({
          queryStringObfuscation: ''
        })

        expect(config).to.have.property('queryStringObfuscation', false)
        t.end()
      })

      t.test('should change to true when passed ".*"', t => {
        const config = web.normalizeConfig({
          queryStringObfuscation: '.*'
        })

        expect(config).to.have.property('queryStringObfuscation', true)
        t.end()
      })

      t.test('should convert to regex when passed valid string', t => {
        const config = web.normalizeConfig({
          queryStringObfuscation: 'a*'
        })

        expect(config).to.have.deep.property('queryStringObfuscation', /a*/gi)
        t.end()
      })

      t.test('should default to true when passed a bad regex', t => {
        const config = web.normalizeConfig({
          queryStringObfuscation: '(?)'
        })

        expect(config).to.have.property('queryStringObfuscation', true)
        t.end()
      })
      t.end()
    })
    t.end()
  })

  t.test('instrument', t => {
    t.test('on request start', t => {
      t.test('should set the parent from the request headers', t => {
        req.headers = {
          'x-datadog-trace-id': '123',
          'x-datadog-parent-id': '456'
        }

        web.instrument(tracer, config, req, res, 'test.request', span => {
          expect(span.context()._traceId.toString(10)).to.equal('123')
          expect(span.context()._parentId.toString(10)).to.equal('456')
        })
        t.end()
      })

      t.test('should set the service name', t => {
        config.service = 'custom'

        web.instrument(tracer, config, req, res, 'test.request', span => {
          expect(span.context()._tags).to.have.property(SERVICE_NAME, 'custom')
        })
        t.end()
      })

      t.test('should activate a scope with the span', t => {
        web.instrument(tracer, config, req, res, 'test.request', span => {
          expect(tracer.scope().active()).to.equal(span)
        })
        t.end()
      })

      t.test('should add request tags to the span', t => {
        req.method = 'GET'
        req.url = '/user/123'
        req.headers['user-agent'] = 'curl'
        req.headers['x-forwarded-for'] = '8.8.8.8'
        res.statusCode = '200'

        web.instrument(tracer, config, req, res, 'test.request', span => {
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
        t.end()
      })

      t.test('should add client ip tag to the span when enabled', t => {
        req.headers['x-forwarded-for'] = '8.8.8.8'

        config.clientIpEnabled = true

        web.normalizeConfig(config)
        web.instrument(tracer, config, req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.include({
            [HTTP_CLIENT_IP]: '8.8.8.8'
          })
        })
        t.end()
      })

      t.test('should add custom client ip tag to the span when it is configured', t => {
        req.headers['X-Forwad-For'] = '8.8.8.8'

        config.clientIpEnabled = true
        config.clientIpHeader = 'X-Forwad-For'

        web.normalizeConfig(config)
        web.instrument(tracer, config, req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.include({
            [HTTP_CLIENT_IP]: '8.8.8.8'
          })
        })
        t.end()
      })

      t.test('should not add custom client ip tag to the span when it is not configured', t => {
        req.headers['X-Forwad-For'] = '8.8.8.8'

        config.clientIpEnabled = true

        web.normalizeConfig(config)
        web.instrument(tracer, config, req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.not.have.property(HTTP_CLIENT_IP)
        })
        t.end()
      })

      t.test('should not add client ip tag to the span when disabled', t => {
        req.headers['x-forwarded-for'] = '8.8.8.8'

        config.clientIpEnabled = false

        web.normalizeConfig(config)
        web.instrument(tracer, config, req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.not.have.property(HTTP_CLIENT_IP)
        })
        t.end()
      })

      t.test('should not replace client ip when it exists', t => {
        req.headers['x-forwarded-for'] = '8.8.8.8'

        config.clientIpEnabled = true

        web.instrument(tracer, config, req, res, 'test.request', span => {
          const tags = span.context()._tags

          span.setTag(HTTP_CLIENT_IP, '1.1.1.1')

          res.end()

          expect(tags).to.include({
            [HTTP_CLIENT_IP]: '1.1.1.1'
          })
        })
        t.end()
      })

      t.test('should not add client ip tag when no candidate header is present in request', t => {
        config.clientIpEnabled = true

        web.instrument(tracer, config, req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.not.have.property(HTTP_CLIENT_IP)
        })
        t.end()
      })

      t.test('should add configured headers to the span tags', t => {
        req.headers.req = 'incoming'
        req.headers.res = 'outgoing'
        config.headers = ['host', 'req:http.req', 'server', 'res:http.res']
        config = web.normalizeConfig(config)

        web.instrument(tracer, config, req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.include({
            [`${HTTP_REQUEST_HEADERS}.host`]: 'localhost',
            'http.req': 'incoming',
            [`${HTTP_RESPONSE_HEADERS}.server`]: 'test',
            'http.res': 'outgoing'
          })
        })
        t.end()
      })

      t.test('should only start one span for the entire request', t => {
        web.instrument(tracer, config, req, res, 'test.request', span1 => {
          web.instrument(tracer, config, req, res, 'test.request', span2 => {
            expect(span1).to.equal(span2)
          })
        })
        t.end()
      })

      t.test('should allow overriding the span name', t => {
        web.instrument(tracer, config, req, res, 'test.request', () => {
          web.instrument(tracer, config, req, res, 'test2.request', span => {
            expect(span.context()._name).to.equal('test2.request')
          })
        })
        t.end()
      })

      t.test('should allow overriding the span service name', t => {
        web.instrument(tracer, config, req, res, 'test.request', span => {
          config.service = 'test2'
          web.instrument(tracer, config, req, res, 'test.request')

          expect(span.context()._tags).to.have.property('service.name', 'test2')
        })
        t.end()
      })

      t.test('should only wrap res.end once', t => {
        web.instrument(tracer, config, req, res, 'test.request')
        const end = res.end
        web.instrument(tracer, config, req, res, 'test.request')

        expect(end).to.equal(res.end)
        t.end()
      })

      t.test('should use the config from the last call', t => {
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
        t.end()
      })

      t.test('should obfuscate the query string from the URL', t => {
        const config = web.normalizeConfig({
          queryStringObfuscation: 'secret=.*?(&|$)'
        })

        req.method = 'GET'
        req.url = '/user/123?secret=password&foo=bar'
        res.statusCode = '200'

        web.instrument(tracer, config, req, res, 'test.request', span => {
          const tags = span.context()._tags

          res.end()

          expect(tags).to.include({
            [HTTP_URL]: 'http://localhost/user/123?<redacted>foo=bar'
          })
        })
        t.end()
      })

      t.test('should handle CORS preflight', t => {
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

        web.instrument(tracer, config, req, res, 'test.request')

        res.writeHead()

        expect(res.setHeader).to.have.been.calledWith('access-control-allow-headers', headers)
        t.end()
      })

      t.test('should handle CORS preflight with partial headers', t => {
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

        web.instrument(tracer, config, req, res, 'test.request')

        res.writeHead()

        expect(res.setHeader).to.have.been.calledWith('access-control-allow-headers', headers)
        t.end()
      })

      t.test('should handle CORS preflight when the origin does not match', t => {
        const headers = ['x-datadog-trace-id']

        req.method = 'OPTIONS'
        req.headers.origin = 'http://test.com'
        req.headers['access-control-request-headers'] = headers

        web.instrument(tracer, config, req, res, 'test.request')

        res.writeHead()

        expect(res.setHeader).to.not.have.been.called
        t.end()
      })

      t.test('should handle CORS preflight when no header was requested', t => {
        req.method = 'OPTIONS'
        req.headers.origin = 'http://test.com'

        res.getHeaders.returns({
          'access-control-allow-origin': 'http://test.com'
        })

        web.instrument(tracer, config, req, res, 'test.request')

        res.writeHead()

        expect(res.setHeader).to.not.have.been.called
        t.end()
      })

      t.test('should support https', t => {
        req.url = '/user/123'
        req.headers['user-agent'] = 'curl'
        req.headers['x-forwarded-for'] = '8.8.8.8'
        req.socket = { encrypted: true }

        web.instrument(tracer, config, req, res, 'test.request', span => {
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
        t.end()
      })

      t.test('should support HTTP2 compatibility API', t => {
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

        web.instrument(tracer, config, req, res, 'test.request', span => {
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
        t.end()
      })

      t.test('should drop filtered out requests', t => {
        config.filter = () => false

        web.instrument(tracer, config, req, res, 'test.request', span => {
          const sampling = span.context()._sampling

          res.end()

          expect(sampling).to.have.property('priority', USER_REJECT)
        })
        t.end()
      })
      t.end()
    })

    t.test('on request end', t => {
      t.beforeEach(() => {
        web.instrument(tracer, config, req, res, 'test.request', reqSpan => {
          span = reqSpan
          tags = span.context()._tags
        })
      })

      t.test('should finish the request span', t => {
        sinon.spy(span, 'finish')

        res.end()

        expect(span.finish).to.have.been.called
        t.end()
      })

      t.test('should should only finish once', t => {
        sinon.spy(span, 'finish')

        res.end()
        res.end()

        expect(span.finish).to.have.been.calledOnce
        t.end()
      })

      t.test('should finish middleware spans', t => {
        web.wrapMiddleware(req, () => {}, 'middleware', () => {
          const span = tracer.scope().active()

          sinon.spy(span, 'finish')

          res.end()

          expect(span.finish).to.have.been.called
        })
        t.end()
      })

      t.test('should execute any beforeEnd handlers', t => {
        const spy1 = sinon.spy()
        const spy2 = sinon.spy()

        web.beforeEnd(req, spy1)
        web.beforeEnd(req, spy2)

        res.end()

        expect(spy1).to.have.been.called
        expect(spy2).to.have.been.called
        t.end()
      })

      t.test('should call the original end', t => {
        res.end()

        expect(end).to.have.been.called
        t.end()
      })

      t.test('should add response tags to the span', t => {
        req.method = 'GET'
        req.url = '/user/123'
        res.statusCode = 200

        res.end()

        expect(tags).to.include({
          [RESOURCE_NAME]: 'GET',
          [HTTP_STATUS_CODE]: 200
        })
        t.end()
      })

      t.test('should set the error tag if the request is an error', t => {
        res.statusCode = 500

        res.end()

        expect(tags).to.include({
          [ERROR]: true
        })
        t.end()
      })

      t.test('should set the error tag if the configured validator returns false', t => {
        config.validateStatus = () => false

        res.end()

        expect(tags).to.include({
          [ERROR]: true
        })
        t.end()
      })

      t.test('should use the user provided route', t => {
        span.setTag('http.route', '/custom/route')

        res.end()

        expect(tags).to.include({
          [HTTP_ROUTE]: '/custom/route'
        })
        t.end()
      })

      t.test('should execute the request end hook', t => {
        config.hooks.request = sinon.spy()

        res.end()

        expect(config.hooks.request).to.have.been.calledWith(span, req, res)
        t.end()
      })

      t.test('should execute multiple end hooks', t => {
        config.hooks = {
          request: sinon.spy()
        }

        web.instrument(tracer, config, req, res, 'test.request', span => {
          res.end()

          expect(config.hooks.request).to.have.been.calledWith(span, req, res)
        })
        t.end()
      })

      t.test('should set the resource name from the http.route tag set in the hooks', t => {
        config.hooks = {
          request: span => span.setTag('http.route', '/custom/route')
        }

        web.instrument(tracer, config, req, res, 'test.request', span => {
          res.end()

          expect(tags).to.have.property('resource.name', 'GET /custom/route')
        })
        t.end()
      })
      t.end()
    })
    t.end()
  })

  t.test('enterRoute', t => {
    t.beforeEach(() => {
      config = web.normalizeConfig(config)
      web.instrument(tracer, config, req, res, 'test.request', () => {
        span = tracer.scope().active()
        tags = span.context()._tags
      })
    })

    t.test('should add a route segment that will be added to the span resource name', t => {
      req.method = 'GET'

      web.enterRoute(req, '/foo')
      web.enterRoute(req, '/bar')
      res.end()

      expect(tags).to.have.property(RESOURCE_NAME, 'GET /foo/bar')
      expect(tags).to.have.property(HTTP_ROUTE, '/foo/bar')
      t.end()
    })

    t.test('should only add valid route segments to the span resource name', t => {
      req.method = 'GET'

      web.enterRoute(req)
      web.enterRoute(req, 1337)
      res.end()

      expect(tags).to.have.property(RESOURCE_NAME, 'GET')
      expect(tags).to.not.have.property(HTTP_ROUTE)
      t.end()
    })
    t.end()
  })

  t.test('exitRoute', t => {
    t.beforeEach(() => {
      config = web.normalizeConfig(config)
      web.instrument(tracer, config, req, res, 'test.request', reqSpan => {
        span = reqSpan
        tags = span.context()._tags
      })
    })

    t.test('should remove a route segment', t => {
      req.method = 'GET'

      web.enterRoute(req, '/foo')
      web.enterRoute(req, '/bar')
      web.exitRoute(req)
      res.end()

      expect(tags).to.have.property(RESOURCE_NAME, 'GET /foo')
      t.end()
    })
    t.end()
  })

  t.test('wrapMiddleware', t => {
    t.beforeEach(() => {
      config = web.normalizeConfig(config)
      web.instrument(tracer, config, req, res, 'test.request', () => {
        span = tracer.scope().active()
        tags = span.context()._tags
      })
    })

    t.test('should activate a scope with the span', (t) => {
      const fn = function test () {
        expect(tracer.scope().active()).to.not.equal(span)
        t.end()
      }

      web.wrapMiddleware(req, fn, 'middleware', () => fn(req, res))
    })
    t.end()
  })

  t.test('finish', t => {
    t.beforeEach(() => {
      config = web.normalizeConfig(config)
      web.instrument(tracer, config, req, res, 'test.request', () => {
        span = tracer.scope().active()
        tags = span.context()._tags
      })
    })

    t.test('should finish the span of the current middleware', (t) => {
      const fn = () => {
        const span = tracer.scope().active()

        sinon.spy(span, 'finish')
        web.finish(req, fn, 'middleware')

        expect(span.finish).to.have.been.called

        t.end()
      }

      web.wrapMiddleware(req, fn, 'middleware', () => fn(req, res))
    })

    t.test('should add an error if provided', (t) => {
      const fn = () => {
        const span = tracer.scope().active()
        const tags = span.context()._tags
        const error = new Error('boom')

        sinon.spy(span, 'finish')
        web.finish(req, error)

        expect(tags[ERROR_TYPE]).to.equal(error.name)
        expect(tags[ERROR_MESSAGE]).to.equal(error.message)
        expect(tags[ERROR_STACK]).to.equal(error.stack)

        t.end()
      }

      web.wrapMiddleware(req, fn, 'middleware', () => fn(req, res))
    })
    t.end()
  })

  t.test('root', t => {
    t.test('should return the request root span', t => {
      web.instrument(tracer, config, req, res, 'test.request', () => {
        const span = tracer.scope().active()

        web.wrapMiddleware(req, () => {}, 'express.middleware', () => {
          expect(web.root(req)).to.equal(span)
        })
      })
      t.end()
    })

    t.test('should return null when not yet instrumented', t => {
      expect(web.root(req)).to.be.null
      t.end()
    })
    t.end()
  })

  t.test('active', t => {
    t.test('should return the request span by default', t => {
      web.instrument(tracer, config, req, res, 'test.request', () => {
        expect(web.active(req)).to.equal(tracer.scope().active())
      })
      t.end()
    })

    t.test('should return the active middleware span', t => {
      web.instrument(tracer, config, req, res, 'test.request', () => {
        const span = tracer.scope().active()

        web.wrapMiddleware(req, () => {}, 'express.middleware', () => {
          expect(web.active(req)).to.not.be.null
          expect(web.active(req)).to.not.equal(span)
        })
      })
      t.end()
    })

    t.test('should return null when not yet instrumented', t => {
      expect(web.active(req)).to.be.null
      t.end()
    })
    t.end()
  })

  t.test('addError', t => {
    t.beforeEach(() => {
      config = web.normalizeConfig(config)
      web.instrument(tracer, config, req, res, 'test.request', () => {
        span = tracer.scope().active()
        tags = span.context()._tags
      })
    })

    t.test('should add an error to the request span', t => {
      const error = new Error('boom')

      web.addError(req, error)
      web.addStatusError(req, 500)

      expect(tags).to.include({
        [ERROR]: error
      })
      t.end()
    })

    t.test('should override an existing error', t => {
      const error = new Error('boom')

      web.addError(req, new Error('prrr'))
      web.addError(req, error)
      web.addStatusError(req, 500)

      expect(tags).to.include({
        [ERROR]: error
      })
      t.end()
    })
    t.end()
  })

  t.test('addStatusError', t => {
    t.beforeEach(() => {
      config = web.normalizeConfig(config)
      web.instrument(tracer, config, req, res, 'test.request', () => {
        span = tracer.scope().active()
        tags = span.context()._tags
      })
    })

    t.test('should flag the request as an error', t => {
      web.addStatusError(req, 500)

      expect(tags).to.include({
        [ERROR]: true
      })
      t.end()
    })

    t.test('should only flag requests as an error for configured status codes', t => {
      config.validateStatus = () => true

      web.addStatusError(req, 500)

      expect(tags).to.not.have.property(ERROR)
      t.end()
    })
    t.end()
  })

  t.test('allowlistFilter', t => {
    t.beforeEach(() => {
      config = { allowlist: ['/_okay'] }
      config = web.normalizeConfig(config)
    })

    t.test('should not filter the url', t => {
      const filtered = config.filter('/_okay')
      expect(filtered).to.equal(true)
      t.end()
    })

    t.test('should filter the url', t => {
      const filtered = config.filter('/_notokay')
      expect(filtered).to.equal(false)
      t.end()
    })
    t.end()
  })

  t.test('whitelistFilter', t => {
    t.beforeEach(() => {
      config = { whitelist: ['/_okay'] }
      config = web.normalizeConfig(config)
    })

    t.test('should not filter the url', t => {
      const filtered = config.filter('/_okay')
      expect(filtered).to.equal(true)
      t.end()
    })

    t.test('should filter the url', t => {
      const filtered = config.filter('/_notokay')
      expect(filtered).to.equal(false)
      t.end()
    })
    t.end()
  })

  t.test('blocklistFilter', t => {
    t.beforeEach(() => {
      config = { blocklist: ['/_notokay'] }
      config = web.normalizeConfig(config)
    })

    t.test('should not filter the url', t => {
      const filtered = config.filter('/_okay')
      expect(filtered).to.equal(true)
      t.end()
    })

    t.test('should filter the url', t => {
      const filtered = config.filter('/_notokay')
      expect(filtered).to.equal(false)
      t.end()
    })
    t.end()
  })

  t.test('blacklistFilter', t => {
    t.beforeEach(() => {
      config = { blacklist: ['/_notokay'] }
      config = web.normalizeConfig(config)
    })

    t.test('should not filter the url', t => {
      const filtered = config.filter('/_okay')
      expect(filtered).to.equal(true)
      t.end()
    })

    t.test('should filter the url', t => {
      const filtered = config.filter('/_notokay')
      expect(filtered).to.equal(false)
      t.end()
    })
    t.end()
  })

  t.test('obfuscateQs', t => {
    const url = 'http://perdu.com/path/'
    const qs = '?data=secret'

    let config

    t.beforeEach(() => {
      config = {
        queryStringObfuscation: /secret/gi
      }
    })

    t.test('should not obfuscate when passed false', t => {
      config.queryStringObfuscation = false

      const result = web.obfuscateQs(config, url + qs)

      expect(result).to.equal(url + qs)
      t.end()
    })

    t.test('should not obfuscate when no querystring is found', t => {
      const result = web.obfuscateQs(config, url)

      expect(result).to.equal(url)
      t.end()
    })

    t.test('should remove the querystring if passed true', t => {
      config.queryStringObfuscation = true

      const result = web.obfuscateQs(config, url + qs)

      expect(result).to.equal(url)
      t.end()
    })

    t.test('should obfuscate only the querystring part of the url', t => {
      const result = web.obfuscateQs(config, url + 'secret/' + qs)

      expect(result).to.equal(url + 'secret/?data=<redacted>')
      t.end()
    })
    t.end()
  })
  t.end()
})
