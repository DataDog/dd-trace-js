'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')

require('../../setup/core')
const tagsExt = require('../../../../../ext/tags')

const ERROR = tagsExt.ERROR
const HTTP_ENDPOINT = tagsExt.HTTP_ENDPOINT
const HTTP_ROUTE = tagsExt.HTTP_ROUTE
const RESOURCE_NAME = tagsExt.RESOURCE_NAME

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
    req = {
      method: 'GET',
      headers: {
        host: 'localhost',
        date: 'now',
      },
    }
    end = sinon.stub()
    res = {
      statusCode: 200,
      end,
      getHeader: sinon.stub(),
      getHeaders: sinon.stub().returns({}),
      setHeader: sinon.spy(),
      writeHead: () => {},
    }
    res.getHeader.withArgs('server').returns('test')
    config = { hooks: {} }

    tracer = require('../../..').init({ plugins: false })
    web = require('../../../src/plugins/util/web')
    config = web.normalizeConfig(config)
  })

  describe('normalizeConfig', () => {
    it('should set the correct defaults', () => {
      const config = web.normalizeConfig({})

      assert.ok(Object.hasOwn(config, 'headers'))
      assert.ok(Array.isArray(config.headers))
      assert.ok(Object.hasOwn(config, 'validateStatus'))
      assert.strictEqual(typeof config.validateStatus, 'function')
      assert.strictEqual(config.validateStatus(200), true)
      assert.strictEqual(config.validateStatus(500), false)
      assert.ok(Object.hasOwn(config, 'hooks'))
      assert.ok(typeof config.hooks === 'object' && config.hooks !== null)
      assert.ok(Object.hasOwn(config.hooks, 'request'))
      assert.strictEqual(typeof config.hooks.request, 'function')
      assert.strictEqual(config.queryStringObfuscation, true)
    })

    it('should use the shared config if set', () => {
      const config = web.normalizeConfig({
        headers: ['test'],
        validateStatus: code => false,
        hooks: {
          request: () => 'test',
        },
      })

      assert.deepStrictEqual(config.headers, [['test', undefined]])
      assert.strictEqual(config.validateStatus(200), false)
      assert.ok(Object.hasOwn(config, 'hooks'))
      assert.strictEqual(config.hooks.request(), 'test')
    })

    describe('queryStringObfuscation', () => {
      it('should keep booleans as is', () => {
        const config = web.normalizeConfig({
          queryStringObfuscation: false,
        })

        assert.strictEqual(config.queryStringObfuscation, false)
      })

      it('should change to false when passed empty string', () => {
        const config = web.normalizeConfig({
          queryStringObfuscation: '',
        })

        assert.strictEqual(config.queryStringObfuscation, false)
      })

      it('should change to true when passed ".*"', () => {
        const config = web.normalizeConfig({
          queryStringObfuscation: '.*',
        })

        assert.strictEqual(config.queryStringObfuscation, true)
      })

      it('should convert to regex when passed valid string', () => {
        const config = web.normalizeConfig({
          queryStringObfuscation: 'a*',
        })

        assert.ok('queryStringObfuscation' in config)
        assert.deepStrictEqual(config.queryStringObfuscation, /a*/gi)
      })

      it('should default to true when passed a bad regex', () => {
        const config = web.normalizeConfig({
          queryStringObfuscation: '(?)',
        })

        assert.strictEqual(config.queryStringObfuscation, true)
      })
    })
  })

  describe('root', () => {
    it('should return null when not yet instrumented', () => {
      assert.strictEqual(web.root(req), null)
    })
  })

  describe('active', () => {
    it('should return null when not yet instrumented', () => {
      assert.strictEqual(web.active(req), null)
    })
  })

  describe('addError', () => {
    beforeEach(() => {
      span = tracer.startSpan('test.request')
      tags = span.context().getTags()

      web.patch(req)
      const context = web.getContext(req)
      context.span = span
      context.req = req
      context.res = res
      context.config = config
    })

    it('should add an error to the request span', () => {
      const error = new Error('boom')

      web.addError(req, error)
      web.addStatusError(req, 500)

      assert.strictEqual(tags[ERROR], error)
    })

    it('should override an existing error', () => {
      const error = new Error('boom')

      web.addError(req, new Error('prrr'))
      web.addError(req, error)
      web.addStatusError(req, 500)

      assert.strictEqual(tags[ERROR], error)
    })
  })

  describe('addStatusError', () => {
    beforeEach(() => {
      span = tracer.startSpan('test.request')
      tags = span.context().getTags()

      web.patch(req)
      const context = web.getContext(req)
      context.span = span
      context.req = req
      context.res = res
      context.config = config
    })

    it('should flag the request as an error', () => {
      web.addStatusError(req, 500)

      assert.strictEqual(tags[ERROR], true)
    })

    it('should only flag requests as an error for configured status codes', () => {
      config.validateStatus = () => true

      web.addStatusError(req, 500)

      assert.ok(!(ERROR in tags))
    })
  })

  describe('allowlistFilter', () => {
    beforeEach(() => {
      config = { allowlist: ['/_okay'] }
      config = web.normalizeConfig(config)
    })

    it('should not filter the url', () => {
      const filtered = config.filter('/_okay')
      assert.strictEqual(filtered, true)
    })

    it('should filter the url', () => {
      const filtered = config.filter('/_notokay')
      assert.strictEqual(filtered, false)
    })
  })

  describe('whitelistFilter', () => {
    beforeEach(() => {
      config = { whitelist: ['/_okay'] }
      config = web.normalizeConfig(config)
    })

    it('should not filter the url', () => {
      const filtered = config.filter('/_okay')
      assert.strictEqual(filtered, true)
    })

    it('should filter the url', () => {
      const filtered = config.filter('/_notokay')
      assert.strictEqual(filtered, false)
    })
  })

  describe('blocklistFilter', () => {
    beforeEach(() => {
      config = { blocklist: ['/_notokay'] }
      config = web.normalizeConfig(config)
    })

    it('should not filter the url', () => {
      const filtered = config.filter('/_okay')
      assert.strictEqual(filtered, true)
    })

    it('should filter the url', () => {
      const filtered = config.filter('/_notokay')
      assert.strictEqual(filtered, false)
    })
  })

  describe('blacklistFilter', () => {
    beforeEach(() => {
      config = { blacklist: ['/_notokay'] }
      config = web.normalizeConfig(config)
    })

    it('should not filter the url', () => {
      const filtered = config.filter('/_okay')
      assert.strictEqual(filtered, true)
    })

    it('should filter the url', () => {
      const filtered = config.filter('/_notokay')
      assert.strictEqual(filtered, false)
    })
  })

  describe('http.endpoint tagging', () => {
    beforeEach(() => {
      span = tracer.startSpan('test.request')
      tags = span.context().getTags()

      req.url = '/'

      web.patch(req)
      const context = web.getContext(req)
      context.span = span
      context.req = req
      context.res = res
      context.config = config
    })

    it('should derive http.endpoint when no framework route is available', () => {
      config = web.normalizeConfig({ resourceRenamingEnabled: true })
      req.method = 'GET'
      req.url = '/api/orders/12345/items?foo=bar'

      const context = web.getContext(req)
      context.config = config

      web.finishAll(context)

      // `tags` was captured from span.context().getTags() before finishAll;
      // the underlying tags object is still the original (clearTags() rebinds,
      // but doesn't mutate the captured reference).
      assert.ok(!Object.hasOwn(tags, HTTP_ROUTE))
      assert.strictEqual(tags[HTTP_ENDPOINT], '/api/orders/{param:int}/items')
    })

    it('should not set http.endpoint when resource renaming is disabled', () => {
      config = web.normalizeConfig({ resourceRenamingEnabled: false })
      req.method = 'GET'
      req.url = '/api/orders/12345/items'

      const context = web.getContext(req)
      context.config = config

      web.finishAll(context)

      assert.ok(!Object.hasOwn(tags, HTTP_ENDPOINT))
      assert.ok(!Object.hasOwn(tags, HTTP_ROUTE))
      assert.strictEqual(tags[RESOURCE_NAME], 'GET')
    })
  })
})
