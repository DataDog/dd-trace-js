'use strict'

let Reporter = require('../../src/appsec/reporter')
const Engine = require('../../src/gateway/engine')
const als = require('../../src/gateway/als')
const Addresses = require('../../src/appsec/addresses')
const log = require('../../src/log')
const URL = require('url').URL
const os = require('os')
const libVersion = require('../../lib/version')

const MAX_EVENT_BACKLOG = 1e6

describe('reporter', () => {
  let scope

  function stubActiveSpan () {
    const span = {
      setTag: sinon.stub(),
      context: sinon.stub().returns({
        toSpanId: sinon.stub().returns('spanId'),
        toTraceId: sinon.stub().returns('traceId')
      })
    }

    sinon.stub(scope, 'active').returns(span)

    return span
  }

  beforeEach(() => {
    scope = {
      active: () => null
    }

    global._ddtrace = {
      _tracer: {
        _service: 'service',
        _env: 'env',
        _version: 'version',
        _tags: { a: 1, b: 2 },
        scope: sinon.stub().returns(scope)
      }
    }
  })

  afterEach((cb) => {
    sinon.restore()
    Engine.manager.clear()
    als.exit(cb)
    Reporter.events.clear()
    delete global._ddtrace
  })

  describe('resolveHTTPAddresses', () => {
    it('should return empty object when no context', () => {
      const result = Reporter.resolveHTTPAddresses()

      expect(result).to.be.an('object').that.is.empty
    })

    it('should return resolved addresses', () => {
      Engine.startContext()

      const context = Engine.getContext()

      context.store = new Map(Object.entries({
        [Addresses.HTTP_INCOMING_URL]: '/path?query=string',
        [Addresses.HTTP_INCOMING_HEADERS]: {
          host: 'localhost',
          'user-agent': 'arachni'
        },
        [Addresses.HTTP_INCOMING_METHOD]: 'GET',
        [Addresses.HTTP_INCOMING_REMOTE_IP]: '8.8.8.8',
        [Addresses.HTTP_INCOMING_REMOTE_PORT]: 1337
      }))

      const result = Reporter.resolveHTTPAddresses()

      expect(result).to.deep.equal({
        url: 'http://localhost/path',
        headers: {
          'user-agent': [ 'arachni' ]
        },
        method: 'GET',
        remote_ip: '8.8.8.8',
        remote_port: 1337
      })
    })
  })

  describe('getHeadersToSend', () => {
    it('should return empty object when providing no headers', () => {
      const result = Reporter.getHeadersToSend(null)

      expect(result).to.be.an('object').that.is.empty
    })

    it('should filter and format headers from whitelist', () => {
      const result = Reporter.getHeadersToSend({
        'client-ip': 1,
        'forwarded-for': 2,
        'forwarded': 3,
        'referer': 4,
        'true-client-ip': 5,
        'user-agent': 6,
        'via': 7,
        'x-client-ip': 8,
        'x-cluster-client-ip': 9,
        'x-forwarded-for': 10,
        'x-forwarded': 11,
        'x-real-ip': 12,

        // should not keep those
        'secret-header': 'secret',
        'host': 'localhost'
      })

      expect(result).to.deep.equal({
        'client-ip': [ 1 ],
        'forwarded-for': [ 2 ],
        'forwarded': [ 3 ],
        'referer': [ 4 ],
        'true-client-ip': [ 5 ],
        'user-agent': [ 6 ],
        'via': [ 7 ],
        'x-client-ip': [ 8 ],
        'x-cluster-client-ip': [ 9 ],
        'x-forwarded-for': [ 10 ],
        'x-forwarded': [ 11 ],
        'x-real-ip': [ 12 ]
      })
    })
  })

  describe('getTracerData', () => {
    it('should get tracer data with active span', () => {
      const span = stubActiveSpan()

      const result = Reporter.getTracerData()

      expect(span.setTag).to.have.been.calledTwice
      expect(span.setTag.firstCall).to.have.been.calledWithExactly('manual.keep')
      expect(span.setTag.secondCall).to.have.been.calledWithExactly('appsec.event', true)
      expect(result).to.deep.equal({
        serviceName: 'service',
        serviceEnv: 'env',
        serviceVersion: 'version',
        tags: ['a:1', 'b:2'],
        spanId: 'spanId',
        traceId: 'traceId'
      })
    })

    it('should get tracer data without active span', () => {
      const result = Reporter.getTracerData()

      expect(result).to.deep.equal({
        serviceName: 'service',
        serviceEnv: 'env',
        serviceVersion: 'version',
        tags: ['a:1', 'b:2']
      })
    })
  })

  describe('reportAttack', () => {
    it('should do nothing when backlog is full', () => {
      Reporter.reportAttack({}, {}, false)

      expect(Reporter.events.size).to.equal(1)

      sinon.stub(Reporter.events, 'size').get(() => MAX_EVENT_BACKLOG + 1)

      expect(Reporter.events.size).to.equal(MAX_EVENT_BACKLOG + 1)

      Reporter.reportAttack({}, {}, false)

      expect(Reporter.events.size).to.equal(MAX_EVENT_BACKLOG + 1)
    })

    it('should build the event', () => {
      const rule = {
        id: 'ruleId',
        name: 'ruleName',
        tags: {
          type: 'ruleType',
          category: 'ruleCategory'
        }
      }

      const ruleMatch = {
        operator: 'matchOperator',
        operator_value: 'matchOperatorValue',
        parameters: [{
          address: 'server.request.uri.raw',
          key_path: [],
          value: '../..'
        }, {
          address: 'server.request.headers.no_cookies',
          key_path: ['user-agent'],
          value: 'Arachni/v1'
        }],
        highlight: [
          'numero_uno',
          'numero_dos'
        ]
      }

      Engine.startContext()

      const context = Engine.getContext()

      context.store = new Map(Object.entries({
        [Addresses.HTTP_INCOMING_URL]: '/path?query=string',
        [Addresses.HTTP_INCOMING_HEADERS]: {
          host: 'localhost',
          'user-agent': 'arachni'
        },
        [Addresses.HTTP_INCOMING_METHOD]: 'GET',
        [Addresses.HTTP_INCOMING_REMOTE_IP]: '8.8.8.8',
        [Addresses.HTTP_INCOMING_REMOTE_PORT]: 1337
      }))

      stubActiveSpan()

      const event = Reporter.reportAttack(rule, ruleMatch, false)

      expect(Reporter.events).to.have.all.keys(event)

      expect(event).to.have.property('event_id').that.is.a('string')
      expect(event).to.have.property('detected_at').that.is.a('string')
      expect(event.rule).to.equal(rule)
      expect(event.rule_match).to.equal(ruleMatch)
      expect(event).to.deep.include({
        event_type: 'appsec',
        event_version: '1.0.0',
        rule: {
          id: 'ruleId',
          name: 'ruleName',
          tags: {
            type: 'ruleType',
            category: 'ruleCategory'
          }
        },
        rule_match: {
          operator: 'matchOperator',
          operator_value: 'matchOperatorValue',
          parameters: [{
            address: 'server.request.uri.raw',
            key_path: [],
            value: '../..'
          }, {
            address: 'server.request.headers.no_cookies',
            key_path: ['user-agent'],
            value: 'Arachni/v1'
          }],
          highlight: [
            'numero_uno',
            'numero_dos'
          ]
        }
      })

      expect(event).to.have.nested.property('context.host.context_version').that.equals('0.1.0')
      expect(event).to.have.nested.property('context.host.os_type').that.equals(os.type())
      expect(event).to.have.nested.property('context.host.hostname').that.equals(os.hostname())

      expect(event).to.have.nested.property('context.http.context_version').that.equals('1.0.0')
      expect(event).to.have.nested.property('context.http.request.method').that.equals('GET')
      expect(event).to.have.nested.property('context.http.request.url').that.equals('http://localhost/path')
      // expect(event).to.have.nested.property('context.http.request.ressource').that.equals('')
      expect(event).to.have.nested.property('context.http.request.remote_ip').that.equals('8.8.8.8')
      expect(event).to.have.nested.property('context.http.request.remote_port').that.equals(1337)
      expect(event).to.have.nested.property('context.http.request.headers').that.deep.equals({
        'user-agent': ['arachni']
      })

      expect(event).to.have.nested.property('context.library.context_version').that.equals('0.1.0')
      expect(event).to.have.nested.property('context.library.runtime_type').that.equals('nodejs')
      expect(event).to.have.nested.property('context.library.runtime_version').that.equals(process.version)
      expect(event).to.have.nested.property('context.library.lib_version').that.equals(libVersion)

      expect(event).to.have.nested.property('context.service.context_version').that.equals('0.1.0')
      expect(event).to.have.nested.property('context.service.name').that.equals('service')
      expect(event).to.have.nested.property('context.service.environment').that.equals('env')
      expect(event).to.have.nested.property('context.service.version').that.equals('version')

      expect(event).to.have.nested.property('context.span.context_version').that.equals('0.1.0')
      expect(event).to.have.nested.property('context.span.id').that.equals('spanId')

      expect(event).to.have.nested.property('context.tags.context_version').that.equals('0.1.0')
      expect(event).to.have.nested.property('context.tags.values').that.deep.equals(['a:1', 'b:2'])

      expect(event).to.have.nested.property('context.trace.context_version').that.equals('0.1.0')
      expect(event).to.have.nested.property('context.trace.id').that.equals('traceId')
    })
  })

  describe('flush', () => {
    let request

    beforeEach(() => {
      global._ddtrace._tracer._exporter = {
        _writer: {
          _url: new URL('http://test:123')
        }
      }

      request = sinon.stub().yieldsAsync(null, {}, 200)

      Reporter = proxyquire('../src/appsec/reporter', {
        '../exporters/agent/request': request
      })
    })

    it('should do nothing when called in parallel', () => {
      Reporter.events.add({})
      expect(Reporter.flush()).to.not.be.false

      Reporter.events.add({})
      expect(Reporter.flush()).to.be.false

      expect(request).to.have.been.calledOnce
    })

    it('should do nothing if no events is found', () => {
      expect(Reporter.flush()).to.be.false
      expect(request).to.not.have.been.called
    })

    it('should log when backlog is full', () => {
      sinon.spy(log, 'warn')

      Reporter.events.add({})

      sinon.stub(Reporter.events, 'size').get(() => MAX_EVENT_BACKLOG)

      expect(Reporter.flush()).to.not.be.false
      expect(log.warn).to.have.been.calledOnceWithExactly('Dropping AppSec events because the backlog is full')
      expect(request).to.have.been.calledOnce
    })

    it('should parse socket url', () => {
      global._ddtrace._tracer._exporter._writer._url = new URL('unix:/path.sock')

      Reporter.events.add({})

      expect(Reporter.flush()).to.not.be.false
      expect(request).to.have.been.calledOnce
      expect(request.firstCall.firstArg).to.deep.include({
        path: '/appsec/proxy/api/v2/appsecevts',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        socketPath: '/path.sock'
      })
    })

    it('should send events', () => {
      Reporter.events.add({
        a: 1,
        b: [2, 3, 4],
        c: 5
      })
      Reporter.events.add({
        another: 'event'
      })

      expect(Reporter.flush()).to.not.be.false
      expect(Reporter.events).to.be.empty
      expect(request).to.have.been.calledOnce
      const firstCall = request.firstCall

      const firstArg = firstCall.firstArg
      expect(firstArg).to.deep.include({
        path: '/appsec/proxy/api/v2/appsecevts',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        protocol: 'http:',
        hostname: 'test',
        port: '123'
      })
      expect(firstArg.data).to.be.a('string')
      const data = JSON.parse(firstArg.data)
      expect(data).to.have.property('idempotency_key').that.is.a('string')
      expect(data).to.deep.include({
        protocol_version: 1,
        events: [{
          a: 1,
          b: [2, 3, 4],
          c: 5
        }, {
          another: 'event'
        }]
      })

      const cb = firstCall.lastArg
      expect(cb).to.be.a('function')
    })

    it('should log request error', () => {
      request = sinon.stub().yields(new Error('socket hang up'), null, null)

      Reporter = proxyquire('../src/appsec/reporter', {
        '../exporters/agent/request': request
      })

      sinon.spy(log, 'error')

      Reporter.events.add({})

      expect(Reporter.flush()).to.not.be.false
      expect(request).to.have.been.calledOnce
      expect(log.error).to.have.been.calledOnce
    })
  })
})
