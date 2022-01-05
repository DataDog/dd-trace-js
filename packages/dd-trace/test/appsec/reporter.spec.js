'use strict'

const Reporter = require('../../src/appsec/reporter')
const Engine = require('../../src/appsec/gateway/engine')
const { Context } = require('../../src/appsec/gateway/engine/engine')
const addresses = require('../../src/appsec/addresses')

describe('reporter', () => {
  function stubReq (oldTags = {}) {
    return {
      _datadog: {
        span: {
          context: sinon.stub().returns({
            _tags: oldTags
          }),
          addTags: sinon.stub()
        }
      }
    }
  }

  afterEach(() => {
    sinon.restore()
    Engine.manager.clear()
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
        [addresses.HTTP_INCOMING_RESPONSE_CODE]: 201,
        [addresses.HTTP_INCOMING_RESPONSE_HEADERS]: {
          'content-type': 'application/json',
          'content-length': 42,
          secret: 'password'
        }
      }))

      const result = Reporter.resolveHTTPResponse(context)

      expect(result).to.deep.equal({
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

  describe('reportAttack', () => {
    it('should do nothing when passed incomplete objects', () => {
      expect(Reporter.reportAttack('', null)).to.be.false
      expect(Reporter.reportAttack('', new Map())).to.be.false
      expect(Reporter.reportAttack('', new Map([['req', null]]))).to.be.false
      expect(Reporter.reportAttack('', new Map([['req', {}]]))).to.be.false
      expect(Reporter.reportAttack('', new Map([['req', { _datadog: {} }]]))).to.be.false
    })

    it('should add tags to request span', () => {
      const req = stubReq()

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

      expect(req._datadog.span.addTags).to.have.been.calledOnceWithExactly({
        'appsec.event': true,
        'manual.keep': undefined,
        '_dd.origin': 'appsec',
        '_dd.appsec.json': '{"triggers":[{"rule":{},"rule_matches":[{}]}]}',
        'http.request.headers.host': 'localhost',
        'http.request.headers.user-agent': 'arachni',
        'http.useragent': 'arachni',
        'network.client.ip': '8.8.8.8'
      })
    })

    it('should not overwrite origin tag', () => {
      const req = stubReq({ '_dd.origin': 'tracer' })

      const store = new Map()
      store.set('req', req)

      const result = Reporter.reportAttack('[]', store)
      expect(result).to.not.be.false

      expect(req._datadog.span.addTags).to.have.been.calledOnceWithExactly({
        'appsec.event': true,
        'manual.keep': undefined,
        '_dd.appsec.json': '{"triggers":[]}'
      })
    })

    it('should merge attacks json', () => {
      const req = stubReq({ '_dd.appsec.json': '{"triggers":[{"rule":{},"rule_matches":[{}]}]}' })

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

      expect(req._datadog.span.addTags).to.have.been.calledOnceWithExactly({
        'appsec.event': true,
        'manual.keep': undefined,
        '_dd.origin': 'appsec',
        '_dd.appsec.json': '{"triggers":[{"rule":{},"rule_matches":[{}]},{"rule":{}},{"rule":{},"rule_matches":[{}]}]}',
        'http.request.headers.host': 'localhost',
        'network.client.ip': '8.8.8.8'
      })
    })
  })

  describe('finishAttacks', () => {
    it('should do nothing when passed incomplete objects', () => {
      expect(Reporter.finishAttacks(null, {})).to.be.false
      expect(Reporter.finishAttacks({}, {})).to.be.false
      expect(Reporter.finishAttacks({ _datadog: {} }, {})).to.be.false
      expect(Reporter.finishAttacks({ _datadog: { span: {} } }, null)).to.be.false
    })

    it('should add http response data inside request span', () => {
      const req = stubReq()

      const context = new Context()

      context.store = new Map(Object.entries({
        [addresses.HTTP_INCOMING_RESPONSE_HEADERS]: {
          'content-type': 'application/json',
          'content-length': 42,
          secret: 'password'
        }
      }))

      const result = Reporter.finishAttacks(req, context)
      expect(result).to.not.be.false

      expect(req._datadog.span.addTags).to.have.been.calledOnceWithExactly({
        'http.response.headers.content-type': 'application/json',
        'http.response.headers.content-length': '42'
      })
    })
  })
})
