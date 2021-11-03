'use strict'

const Reporter = require('../../src/appsec/reporter')
const Engine = require('../../src/gateway/engine')
const als = require('../../src/gateway/als')
const Addresses = require('../../src/appsec/addresses')
const log = require('../../src/log')

const MAX_EVENT_BACKLOG = 1e6

describe('reporter', () => {
  let scope

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
      const tracer = require('../../').init({ plugins: false })
      const span = tracer.startSpan('test')

      sinon.spy(span, 'setTag')
      sinon.stub(scope, 'active').callsFake(() => tracer.scope().active())

      tracer.scope().activate(span, () => {
        const result = Reporter.getTracerData()

        expect(span.setTag).to.have.been.calledTwice
        expect(span.setTag.firstCall).to.have.been.calledWithExactly('manual.keep')
        expect(span.setTag.secondCall).to.have.been.calledWithExactly('appsec.event', true)
        expect(result.spanId).to.not.be.empty
        expect(result.traceId).to.not.be.empty
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

      const tracer = require('../../').init({ plugins: false })
      const span = tracer.startSpan('test')

      sinon.stub(scope, 'active').callsFake(() => tracer.scope().active())

      tracer.scope().activate(span, () => {
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
        expect(event).to.have.nested.property('context.host.os_type').that.is.a('string')
        expect(event).to.have.nested.property('context.host.hostname').that.is.a('string')

        expect(event).to.have.nested.property('context.http.context_version').that.equals('1.0.0')
        expect(event).to.have.nested.property('context.http.request.method').that.is.a('string')
        expect(event).to.have.nested.property('context.http.request.url').that.is.a('string')
        // expect(event).to.have.nested.property('context.http.request.ressource').that.is.a('string')
        expect(event).to.have.nested.property('context.http.request.remote_ip').that.is.a('string')
        expect(event).to.have.nested.property('context.http.request.remote_port').that.is.a('number')
        expect(event).to.have.nested.property('context.http.request.headers').that.is.an('object')

        expect(event).to.have.nested.property('context.library.context_version').that.equals('0.1.0')
        expect(event).to.have.nested.property('context.library.runtime_type').that.equals('nodejs')
        expect(event).to.have.nested.property('context.library.runtime_version').that.is.a('string')
        expect(event).to.have.nested.property('context.library.lib_version').that.is.a('string')

        expect(event).to.have.nested.property('context.service.context_version').that.equals('0.1.0')
        expect(event).to.have.nested.property('context.service.name').that.is.a('string')
        expect(event).to.have.nested.property('context.service.environment').that.is.a('string')
        expect(event).to.have.nested.property('context.service.version').that.is.a('string')

        expect(event).to.have.nested.property('context.span.context_version').that.equals('0.1.0')
        expect(event).to.have.nested.property('context.span.id').that.is.a('string')

        expect(event).to.have.nested.property('context.tags.context_version').that.equals('0.1.0')
        expect(event).to.have.nested.property('context.tags.values').that.is.an('array')

        expect(event).to.have.nested.property('context.trace.context_version').that.equals('0.1.0')
        expect(event).to.have.nested.property('context.trace.id').that.is.a('string')
      })
    })
  })
})
