'use strict'

const proxyquire = require('proxyquire')
const Engine = require('../../src/appsec/gateway/engine')
const { Context } = require('../../src/appsec/gateway/engine/engine')
const addresses = require('../../src/appsec/addresses')

describe('reporter', () => {
  let Reporter
  let span
  let web

  beforeEach(() => {
    span = {
      context: sinon.stub().returns({
        _tags: {}
      }),
      addTags: sinon.stub(),
      setTag: sinon.stub()
    }

    web = {
      root: sinon.stub().returns(span)
    }

    Reporter = proxyquire('../../src/appsec/reporter', {
      '../plugins/util/web': web
    })
  })

  afterEach(() => {
    sinon.restore()
    Engine.manager.clear()
    Reporter.setRateLimit(100)
    Reporter.metricsQueue.clear()
  })

  describe('resolveHTTPRequest', () => {
    it('should return empty object when passed no context', () => {
      const result = Reporter.resolveHTTPRequest()

      expect(result).to.be.an('object').that.is.empty
    })

    it('should return resolved addresses', () => {
      const context = new Context()

      context.store = new Map(Object.entries({
        [addresses.HTTP_INCOMING_URL]: '/path?query=string',
        [addresses.HTTP_INCOMING_HEADERS]: {
          host: 'localhost',
          'user-agent': 'arachni',
          secret: 'password'
        },
        [addresses.HTTP_INCOMING_METHOD]: 'GET',
        [addresses.HTTP_INCOMING_REMOTE_IP]: '8.8.8.8',
        [addresses.HTTP_INCOMING_REMOTE_PORT]: 1337
      }))

      const result = Reporter.resolveHTTPRequest(context)

      expect(result).to.deep.equal({
        headers: {
          'http.request.headers.host': 'localhost',
          'http.request.headers.user-agent': 'arachni'
        },
        remote_ip: '8.8.8.8'
      })
    })
  })

  describe('resolveHTTPResponse', () => {
    it('should return empty object when passed no context', () => {
      const result = Reporter.resolveHTTPResponse()

      expect(result).to.be.an('object').that.is.empty
    })

    it('should return resolved addresses', () => {
      const context = new Context()

      context.store = new Map(Object.entries({
        [addresses.HTTP_INCOMING_ENDPOINT]: '/path/:param',
        [addresses.HTTP_INCOMING_RESPONSE_CODE]: 201,
        [addresses.HTTP_INCOMING_RESPONSE_HEADERS]: {
          'content-type': 'application/json',
          'content-length': 42,
          secret: 'password'
        }
      }))

      const result = Reporter.resolveHTTPResponse(context)

      expect(result).to.deep.equal({
        endpoint: '/path/:param',
        headers: {
          'http.response.headers.content-type': 'application/json',
          'http.response.headers.content-length': '42'
        }
      })
    })
  })

  describe('filterHeaders', () => {
    it('should return empty object when providing no headers', () => {
      const result = Reporter.filterHeaders(null)

      expect(result).to.be.an('object').that.is.empty
    })

    it('should filter and format headers from passlist', () => {
      const result = Reporter.filterHeaders({
        host: 'localhost',
        'user-agent': 42,
        secret: 'password',
        'x-forwarded-for': '10'
      }, [
        'host',
        'user-agent',
        'x-forwarded-for',
        'x-client-ip'
      ], 'prefix.')

      expect(result).to.deep.equal({
        'prefix.host': 'localhost',
        'prefix.user-agent': '42',
        'prefix.x-forwarded-for': '10'
      })
    })
  })

  describe('formatHeaderName', () => {
    it('should format a string', () => {
      expect(Reporter.formatHeaderName('Content-Type')).to.equal('content-type')
      expect(Reporter.formatHeaderName(' Content-Type ')).to.equal('content-type')
      expect(Reporter.formatHeaderName('C!!!ont_____ent----tYp!/!e')).to.equal('c___ont_____ent----typ_/_e')
      expect(Reporter.formatHeaderName('Some.Header')).to.equal('some_header')
      expect(Reporter.formatHeaderName(''.padEnd(300, 'a'))).to.have.lengthOf(200)
    })
  })

  describe('reportMetrics', () => {
    it('should do nothing when passed incomplete objects', () => {
      const req = {}

      web.root.returns(null)

      expect(Reporter.reportMetrics({}, null)).to.be.false
      expect(Reporter.reportMetrics({}, new Map())).to.be.false
      expect(Reporter.reportMetrics({}, new Map([['req', null]]))).to.be.false
      expect(Reporter.reportMetrics({}, new Map([['req', req]]))).to.be.false
    })

    it('should set duration metrics if set', () => {
      const req = {}
      const store = new Map([['req', req]])

      Reporter.reportMetrics({ duration: 1337 }, store)

      expect(web.root).to.have.been.calledOnceWithExactly(req)
      expect(span.setTag).to.have.been.calledOnceWithExactly('_dd.appsec.waf.duration', 1337)
    })

    it('should set ext duration metrics if set', () => {
      const req = {}
      const store = new Map([['req', req]])

      Reporter.reportMetrics({ durationExt: 42 }, store)

      expect(web.root).to.have.been.calledOnceWithExactly(req)
      expect(span.setTag).to.have.been.calledOnceWithExactly('_dd.appsec.waf.duration_ext', 42)
    })

    it('should set rulesVersion if set', () => {
      const req = {}
      const store = new Map([['req', req]])

      Reporter.reportMetrics({ rulesVersion: '1.2.3' }, store)

      expect(web.root).to.have.been.calledOnceWithExactly(req)
      expect(span.setTag).to.have.been.calledOnceWithExactly('_dd.appsec.event_rules.version', '1.2.3')
    })
  })

  describe('reportAttack', () => {
    it('should do nothing when passed incomplete objects', () => {
      const req = {}

      web.root.returns(null)

      expect(Reporter.reportAttack('', null)).to.be.false
      expect(Reporter.reportAttack('', new Map())).to.be.false
      expect(Reporter.reportAttack('', new Map([['req', null]]))).to.be.false
      expect(Reporter.reportAttack('', new Map([['req', req]]))).to.be.false
    })

    it('should add tags to request span', () => {
      const req = {}

      const context = new Context()

      context.store = new Map(Object.entries({
        [addresses.HTTP_INCOMING_URL]: '/path?query=string',
        [addresses.HTTP_INCOMING_HEADERS]: {
          host: 'localhost',
          'user-agent': 'arachni',
          secret: 'password'
        },
        [addresses.HTTP_INCOMING_REMOTE_IP]: '8.8.8.8'
      }))

      const store = new Map()
      store.set('req', req)
      store.set('context', context)

      const result = Reporter.reportAttack('[{"rule":{},"rule_matches":[{}]}]', store)
      expect(result).to.not.be.false
      expect(web.root).to.have.been.calledOnceWith(req)

      expect(span.addTags).to.have.been.calledOnceWithExactly({
        'appsec.event': 'true',
        'manual.keep': 'true',
        '_dd.origin': 'appsec',
        '_dd.appsec.json': '{"triggers":[{"rule":{},"rule_matches":[{}]}]}',
        'http.request.headers.host': 'localhost',
        'http.request.headers.user-agent': 'arachni',
        'http.useragent': 'arachni',
        'network.client.ip': '8.8.8.8'
      })
    })

    it('should not add manual.keep when rate limit is reached', (done) => {
      const req = {}
      const addTags = span.addTags
      const store = new Map([[ 'req', req ]])

      expect(Reporter.reportAttack('', store)).to.not.be.false
      expect(addTags.getCall(0).firstArg).to.have.property('manual.keep').that.equals('true')
      expect(Reporter.reportAttack('', store)).to.not.be.false
      expect(addTags.getCall(1).firstArg).to.have.property('manual.keep').that.equals('true')
      expect(Reporter.reportAttack('', store)).to.not.be.false
      expect(addTags.getCall(2).firstArg).to.have.property('manual.keep').that.equals('true')

      Reporter.setRateLimit(1)

      expect(Reporter.reportAttack('', store)).to.not.be.false
      expect(addTags.getCall(3).firstArg).to.have.property('appsec.event').that.equals('true')
      expect(addTags.getCall(3).firstArg).to.have.property('manual.keep').that.equals('true')
      expect(Reporter.reportAttack('', store)).to.not.be.false
      expect(addTags.getCall(4).firstArg).to.have.property('appsec.event').that.equals('true')
      expect(addTags.getCall(4).firstArg).to.not.have.property('manual.keep')

      setTimeout(() => {
        expect(Reporter.reportAttack('', store)).to.not.be.false
        expect(addTags.getCall(5).firstArg).to.have.property('manual.keep').that.equals('true')
        done()
      }, 1e3)
    })

    it('should not overwrite origin tag', () => {
      span.context()._tags = { '_dd.origin': 'tracer' }

      const req = {}
      const store = new Map()
      store.set('req', req)

      const result = Reporter.reportAttack('[]', store)
      expect(result).to.not.be.false
      expect(web.root).to.have.been.calledOnceWith(req)

      expect(span.addTags).to.have.been.calledOnceWithExactly({
        'appsec.event': 'true',
        'manual.keep': 'true',
        '_dd.appsec.json': '{"triggers":[]}'
      })
    })

    it('should merge attacks json', () => {
      span.context()._tags = { '_dd.appsec.json': '{"triggers":[{"rule":{},"rule_matches":[{}]}]}' }

      const req = {}
      const context = new Context()

      context.store = new Map(Object.entries({
        [addresses.HTTP_INCOMING_URL]: '/path?query=string',
        [addresses.HTTP_INCOMING_HEADERS]: {
          host: 'localhost',
          secret: 'password'
        },
        [addresses.HTTP_INCOMING_REMOTE_IP]: '8.8.8.8'
      }))

      const store = new Map()
      store.set('req', req)
      store.set('context', context)

      const result = Reporter.reportAttack('[{"rule":{}},{"rule":{},"rule_matches":[{}]}]', store)
      expect(result).to.not.be.false
      expect(web.root).to.have.been.calledOnceWith(req)

      expect(span.addTags).to.have.been.calledOnceWithExactly({
        'appsec.event': 'true',
        'manual.keep': 'true',
        '_dd.origin': 'appsec',
        '_dd.appsec.json': '{"triggers":[{"rule":{},"rule_matches":[{}]},{"rule":{}},{"rule":{},"rule_matches":[{}]}]}',
        'http.request.headers.host': 'localhost',
        'network.client.ip': '8.8.8.8'
      })
    })
  })

  describe('finishRequest', () => {
    it('should do nothing when passed incomplete objects', () => {
      const req = {}

      web.root.returns(null)

      expect(Reporter.finishRequest(null, {})).to.be.false
      expect(Reporter.finishRequest(req, {})).to.be.false
    })

    it('should add metrics tags from metricsQueue', () => {
      const req = {}

      Reporter.metricsQueue.set('a', 1)
      Reporter.metricsQueue.set('b', 2)

      Reporter.finishRequest(req)

      expect(web.root).to.have.been.calledOnceWithExactly(req)
      expect(span.addTags).to.have.been.calledOnceWithExactly({ a: 1, b: 2 })
      expect(Reporter.metricsQueue).to.be.empty
    })

    it('should not add http response data when no attack was previously found', () => {
      const req = {}

      const context = new Context()

      context.store = new Map(Object.entries({
        [addresses.HTTP_INCOMING_ENDPOINT]: '/path/:param',
        [addresses.HTTP_INCOMING_RESPONSE_HEADERS]: {
          'content-type': 'application/json',
          'content-length': 42,
          secret: 'password'
        }
      }))

      const result = Reporter.finishRequest(req, context)
      expect(result).to.be.false
      expect(web.root).to.have.been.calledOnceWith(req)
      expect(span.addTags).to.not.have.been.called
    })

    it('should add http response data inside request span', () => {
      const req = {}

      const context = new Context()

      context.store = new Map(Object.entries({
        [addresses.HTTP_INCOMING_ENDPOINT]: '/path/:param',
        [addresses.HTTP_INCOMING_RESPONSE_HEADERS]: {
          'content-type': 'application/json',
          'content-length': 42,
          secret: 'password'
        }
      }))

      span.context()._tags['appsec.event'] = 'true'

      const result = Reporter.finishRequest(req, context)
      expect(result).to.not.be.false
      expect(web.root).to.have.been.calledOnceWith(req)

      expect(span.addTags).to.have.been.calledOnceWithExactly({
        'http.response.headers.content-type': 'application/json',
        'http.response.headers.content-length': '42',
        'http.endpoint': '/path/:param'
      })
    })

    it('should add http response data inside request span without endpoint', () => {
      const req = {}

      const context = new Context()

      context.store = new Map(Object.entries({
        [addresses.HTTP_INCOMING_RESPONSE_HEADERS]: {
          'content-type': 'application/json',
          'content-length': 42,
          secret: 'password'
        }
      }))

      span.context()._tags['appsec.event'] = 'true'

      const result = Reporter.finishRequest(req, context)
      expect(result).to.not.be.false
      expect(web.root).to.have.been.calledOnceWith(req)

      expect(span.addTags).to.have.been.calledOnceWithExactly({
        'http.response.headers.content-type': 'application/json',
        'http.response.headers.content-length': '42'
      })
    })
  })
})
