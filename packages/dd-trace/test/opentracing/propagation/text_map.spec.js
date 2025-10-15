'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../setup/core')

const Config = require('../../../src/config')
const id = require('../../../src/id')
const SpanContext = require('../../../src/opentracing/span_context')
const TraceState = require('../../../src/opentracing/propagation/tracestate')
const { channel } = require('dc-polyfill')
const { setBaggageItem, getBaggageItem, getAllBaggageItems, removeAllBaggageItems } = require('../../../src/baggage')

const { AUTO_KEEP, AUTO_REJECT, USER_KEEP } = require('../../../../../ext/priority')
const { SAMPLING_MECHANISM_MANUAL } = require('../../../src/constants')

const injectCh = channel('dd-trace:span:inject')
const extractCh = channel('dd-trace:span:extract')

describe('TextMapPropagator', () => {
  let TextMapPropagator
  let propagator
  let textMap
  let baggageItems
  let config
  let log
  let telemetryMetrics

  const createContext = (params = {}) => {
    const trace = { started: [], finished: [], tags: {} }
    const spanContext = new SpanContext({
      traceId: id('123', 10),
      spanId: id('456', 10),
      isRemote: params.isRemote === undefined ? true : params.isRemote,
      baggageItems,
      ...params,
      trace: {
        ...trace,
        ...params.trace
      }
    })

    return spanContext
  }

  beforeEach(() => {
    log = {
      debug: sinon.spy()
    }
    telemetryMetrics = {
      manager: {
        namespace: sinon.stub().returns({
          count: sinon.stub().returns({
            inc: sinon.spy()
          })
        })
      }
    }
    TextMapPropagator = proxyquire('../../../src/opentracing/propagation/text_map', {
      '../../log': log,
      '../../telemetry/metrics': telemetryMetrics
    })
    config = new Config({ tagsHeaderMaxLength: 512 })
    propagator = new TextMapPropagator(config)
    textMap = {
      'x-datadog-trace-id': '123',
      'x-datadog-parent-id': '456',
      'ot-baggage-foo': 'bar',
      baggage: 'foo=bar'
    }
    baggageItems = {}
  })

  describe('inject', () => {
    beforeEach(() => {
      baggageItems = {
        foo: 'bar'
      }
    })

    it('should not crash without spanContext', () => {
      const carrier = {}
      propagator.inject(null, carrier)
    })

    it('should not crash without carrier', () => {
      const spanContext = createContext()
      propagator.inject(spanContext, null)
    })

    it('should inject the span context into the carrier', () => {
      const carrier = {}
      const spanContext = createContext()

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('x-datadog-trace-id', '123')
      expect(carrier).to.have.property('x-datadog-parent-id', '456')
      expect(carrier).to.have.property('ot-baggage-foo', 'bar')
      expect(carrier.baggage).to.be.undefined
    })

    it('should handle non-string values', () => {
      const carrier = {}
      const baggageItems = {
        number: 1.23,
        bool: true,
        array: ['foo', 'bar'],
        object: {}
      }
      const spanContext = createContext({ baggageItems })

      propagator.inject(spanContext, carrier)

      expect(carrier['ot-baggage-number']).to.equal('1.23')
      expect(carrier['ot-baggage-bool']).to.equal('true')
      expect(carrier['ot-baggage-array']).to.equal('foo,bar')
      expect(carrier['ot-baggage-object']).to.equal('[object Object]')
      expect(carrier.baggage).to.be.undefined
    })

    it('should handle special characters in baggage', () => {
      const carrier = {}
      setBaggageItem('",;\\()/:<=>?@[]{}🐶é我', '",;\\🐶é我')
      propagator.inject(undefined, carrier)
      // eslint-disable-next-line @stylistic/max-len
      expect(carrier.baggage).to.be.equal('%22%2C%3B%5C%28%29%2F%3A%3C%3D%3E%3F%40%5B%5D%7B%7D%F0%9F%90%B6%C3%A9%E6%88%91=%22%2C%3B%5C%F0%9F%90%B6%C3%A9%E6%88%91')
    })

    it('should drop excess baggage items when there are too many pairs', () => {
      const carrier = {}
      for (let i = 0; i < config.baggageMaxItems + 1; i++) {
        setBaggageItem(`key-${i}`, i)
      }
      propagator.inject(undefined, carrier)
      expect(carrier.baggage.split(',').length).to.equal(config.baggageMaxItems)
    })

    it('should drop excess baggage items when the resulting baggage header contains many bytes', () => {
      const carrier = {}
      setBaggageItem('raccoon', 'chunky')
      setBaggageItem('foo', Buffer.alloc(config.baggageMaxBytes).toString())

      propagator.inject(undefined, carrier)
      expect(carrier.baggage).to.equal('raccoon=chunky')
    })

    it('should inject an existing sampling priority', () => {
      const carrier = {}
      const spanContext = createContext({
        sampling: {
          priority: 0
        }
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('x-datadog-sampling-priority', '0')
    })

    it('should inject the origin', () => {
      const carrier = {}
      const spanContext = createContext({
        trace: {
          origin: 'synthetics',
          tags: {}
        }
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('x-datadog-origin', 'synthetics')
    })

    it('should inject trace tags prefixed for propagation', () => {
      const carrier = {}
      const spanContext = createContext({
        trace: {
          tags: {
            '_dd.p.foo': 'foo',
            bar: 'bar',
            '_dd.p.baz': 'baz'
          }
        }
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('x-datadog-tags', '_dd.p.foo=foo,_dd.p.baz=baz')
    })

    it('should drop trace tags if too large', () => {
      const carrier = {}
      const spanContext = createContext({
        trace: {
          tags: {
            '_dd.p.foo': 'a'.repeat(512)
          }
        }
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.not.have.property('x-datadog-tags')
    })

    it('should drop trace tags if value is invalid', () => {
      const carrier = {}
      const spanContext = createContext({
        trace: {
          tags: {
            '_dd.p.foo': 'hélicoptère'
          }
        }
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.not.have.property('x-datadog-tags')
    })

    it('should drop trace tags if key is invalid', () => {
      const carrier = {}
      const spanContext = createContext({
        trace: {
          tags: {
            _ddupefoo: 'value'
          }
        }
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.not.have.property('x-datadog-tags')
    })

    it('should drop trace tags if disabled', () => {
      config.tagsHeaderMaxLength = 0

      const carrier = {}
      const spanContext = createContext({
        trace: {
          tags: {
            '_dd.p.foo': 'hélicoptère'
          }
        }
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.not.have.property('x-datadog-tags')
    })

    it('should inject the trace B3 headers', () => {
      const carrier = {}
      const spanContext = createContext({
        traceId: id('0000000000000123'),
        spanId: id('0000000000000456'),
        parentId: id('0000000000000789'),
        sampling: {
          priority: USER_KEEP
        }
      })

      config.tracePropagationStyle.inject = ['b3']

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('x-b3-traceid', '0000000000000123')
      expect(carrier).to.have.property('x-b3-spanid', '0000000000000456')
      expect(carrier).to.have.property('x-b3-parentspanid', '0000000000000789')
      expect(carrier).to.have.property('x-b3-sampled', '1')
      expect(carrier).to.have.property('x-b3-flags', '1')
    })

    it('should inject the 128-bit trace ID in B3 headers when available as tag', () => {
      const carrier = {}
      const spanContext = createContext({
        traceId: id('0000000000000123'),
        trace: {
          tags: {
            '_dd.p.tid': '0000000000000234'
          }
        }
      })

      config.tracePropagationStyle.inject = ['b3']

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('x-b3-traceid', '00000000000002340000000000000123')
    })

    it('should inject the 128-bit trace ID in B3 headers when available as ID', () => {
      const carrier = {}
      const spanContext = createContext({
        traceId: id('00000000000002340000000000000123'),
        trace: {
          tags: {
            '_dd.p.tid': '0000000000000234'
          }
        }
      })

      config.tracePropagationStyle.inject = ['b3']

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('x-b3-traceid', '00000000000002340000000000000123')
    })

    it('should inject the traceparent header', () => {
      const carrier = {}
      const spanContext = createContext({
        traceId: id('1111aaaa2222bbbb3333cccc4444dddd', 16),
        spanId: id('5555eeee6666ffff', 16),
        sampling: {
          priority: USER_KEEP,
          mechanism: SAMPLING_MECHANISM_MANUAL
        },
        tracestate: TraceState.fromString('other=bleh,dd=s:2;o:foo_bar_;t.dm:-4'),
        isRemote: false
      })
      // Include invalid characters to verify underscore conversion
      spanContext._trace.origin = 'foo,bar='
      spanContext._trace.tags['_dd.p.foo bar,baz='] = 'abc~!@#$%^&*()_+`-='

      config.tracePropagationStyle.inject = ['tracecontext']

      propagator.inject(spanContext, carrier)
      expect(spanContext._isRemote).to.equal(false)

      expect(carrier).to.have.property('traceparent', '00-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01')
      expect(carrier).to.have.property(
        'tracestate',
        'dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;p:5555eeee6666ffff;s:2;o:foo_bar~;t.dm:-4,other=bleh'
      )
    })

    it('should skip injection of B3 headers without the feature flag', () => {
      const carrier = {}
      const spanContext = createContext({
        traceId: id('0000000000000123'),
        spanId: id('0000000000000456')
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.not.have.property('x-b3-traceid')
    })

    it('should skip injection of traceparent header without the feature flag', () => {
      const carrier = {}
      const spanContext = createContext({
        traceId: id('0000000000000123'),
        spanId: id('0000000000000456')
      })

      config.tracePropagationStyle.inject = []

      propagator.inject(spanContext, carrier)

      expect(carrier).to.not.have.property('traceparent')
    })

    it('should skip injection of datadog headers without the feature flag', () => {
      const carrier = {}
      const spanContext = createContext({
        traceId: id('0000000000000123'),
        spanId: id('0000000000000456')
      })

      config.tracePropagationStyle.inject = []

      propagator.inject(spanContext, carrier)

      expect(carrier).to.not.have.property('x-datadog-trace-id')
      expect(carrier).to.not.have.property('x-datadog-parent-id')
      expect(carrier).to.not.have.property('x-datadog-sampling-priority')
      expect(carrier).to.not.have.property('x-datadog-origin')
      expect(carrier).to.not.have.property('x-datadog-tags')
    })

    it('should publish spanContext and carrier', () => {
      const carrier = {}
      const spanContext = createContext({
        traceId: id('0000000000000123'),
        spanId: id('0000000000000456')
      })

      const onSpanInject = sinon.stub()
      injectCh.subscribe(onSpanInject)

      propagator.inject(spanContext, carrier)

      try {
        expect(onSpanInject).to.be.calledOnce
        expect(onSpanInject.firstCall.args[0]).to.be.deep.equal({ spanContext, carrier })
      } finally {
        injectCh.unsubscribe(onSpanInject)
      }
    })

    describe('baggage telemetry metrics', () => {
      let tracerMetrics

      beforeEach(() => {
        // Get the mocked tracer metrics instance
        tracerMetrics = telemetryMetrics.manager.namespace('tracers')
      })

      it('should track baggage injection metric when baggage is successfully injected', () => {
        const carrier = {}
        setBaggageItem('test-key', 'test-value')

        propagator.inject(undefined, carrier)

        expect(tracerMetrics.count).to.have.been.calledWith('context_header_style.injected', ['header_style:baggage'])
        expect(tracerMetrics.count().inc).to.have.been.called
        expect(carrier.baggage).to.equal('test-key=test-value')
      })

      it('should track truncation metric when baggage item count exceeds limit', () => {
        const carrier = {}
        const originalMaxItems = config.baggageMaxItems
        config.baggageMaxItems = 2

        // Add 3 items to exceed the limit
        setBaggageItem('key1', 'value1')
        setBaggageItem('key2', 'value2')
        setBaggageItem('key3', 'value3')

        propagator.inject(undefined, carrier)

        expect(tracerMetrics.count).to.have.been.calledWith(
          'context_header.truncated',
          ['truncation_reason:baggage_item_count_exceeded']
        )
        expect(tracerMetrics.count().inc).to.have.been.called

        // Restore original config
        config.baggageMaxItems = originalMaxItems
      })

      it('should track truncation metric when baggage byte count exceeds limit', () => {
        const carrier = {}
        const originalMaxBytes = config.baggageMaxBytes
        config.baggageMaxBytes = 50

        // Add a large value to exceed byte limit
        setBaggageItem('small-key', 'a'.repeat(100))

        propagator.inject(undefined, carrier)

        expect(tracerMetrics.count).to.have.been.calledWith(
          'context_header.truncated',
          ['truncation_reason:baggage_byte_count_exceeded']
        )
        expect(tracerMetrics.count().inc).to.have.been.called

        // Restore original config
        config.baggageMaxBytes = originalMaxBytes
      })
    })
  })

  describe('extract', () => {
    it('should extract a span context from the carrier', () => {
      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext.toTraceId()).to.equal(carrier['x-datadog-trace-id'])
      expect(spanContext.toSpanId()).to.equal(carrier['x-datadog-parent-id'])
      expect(spanContext._baggageItems.foo).to.equal(carrier['ot-baggage-foo'])
      expect(spanContext._baggageItems).to.deep.equal({ foo: 'bar' })
      expect(getAllBaggageItems()).to.deep.equal({ foo: 'bar' })
      expect(spanContext._isRemote).to.equal(true)
    })

    it('should extract opentracing baggage when baggage is not a propagation style ', () => {
      config = new Config({
        tracePropagationStyle: {
          extract: ['datadog', 'tracecontext'],
          inject: ['datadog', 'tracecontext']
        }
      })
      propagator = new TextMapPropagator(config)
      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext.toTraceId()).to.equal(carrier['x-datadog-trace-id'])
      expect(spanContext.toSpanId()).to.equal(carrier['x-datadog-parent-id'])
      expect(spanContext._baggageItems.foo).to.equal(carrier['ot-baggage-foo'])
      expect(spanContext._baggageItems).to.deep.equal({ foo: 'bar' })
      expect(getAllBaggageItems()).to.deep.equal({})
      expect(spanContext._isRemote).to.equal(true)
    })

    it('should extract otel baggage items with special characters', () => {
      config = new Config()
      propagator = new TextMapPropagator(config)
      const carrier = {
        'x-datadog-trace-id': '123',
        'x-datadog-parent-id': '456',
        baggage: '%22%2C%3B%5C%28%29%2F%3A%3C%3D%3E%3F%40%5B%5D%7B%7D=%22%2C%3B%5C'
      }
      const spanContext = propagator.extract(carrier)
      expect(spanContext._baggageItems).to.deep.equal({})
      expect(getAllBaggageItems()).to.deep.equal({ '",;\\()/:<=>?@[]{}': '",;\\' })
    })

    it('should not extract baggage when the header is malformed', () => {
      const carrierA = {
        'x-datadog-trace-id': '123',
        'x-datadog-parent-id': '456',
        baggage: 'no-equal-sign,foo=gets-dropped-because-previous-pair-is-malformed'
      }
      const spanContextA = propagator.extract(carrierA)
      expect(spanContextA._baggageItems).to.deep.equal({})
      expect(getAllBaggageItems()).to.deep.equal({})

      const carrierB = {
        'x-datadog-trace-id': '123',
        'x-datadog-parent-id': '456',
        baggage: 'foo=gets-dropped-because-subsequent-pair-is-malformed,='
      }
      const spanContextB = propagator.extract(carrierB)
      expect(spanContextB._baggageItems).to.deep.equal({})
      expect(getAllBaggageItems()).to.deep.equal({})

      const carrierC = {
        'x-datadog-trace-id': '123',
        'x-datadog-parent-id': '456',
        baggage: '=no-key'
      }
      const spanContextC = propagator.extract(carrierC)
      expect(spanContextC._baggageItems).to.deep.equal({})
      expect(getAllBaggageItems()).to.deep.equal({})

      const carrierD = {
        'x-datadog-trace-id': '123',
        'x-datadog-parent-id': '456',
        baggage: 'no-value='
      }
      const spanContextD = propagator.extract(carrierD)
      expect(spanContextD._baggageItems).to.deep.equal({})
      expect(getAllBaggageItems()).to.deep.equal({})
    })

    it('should add baggage items to span tags', () => {
      // should add baggage with default keys
      let carrier = {
        'x-datadog-trace-id': '123',
        'x-datadog-parent-id': '456',
        baggage: 'user.id=capybara,session.id=987,account.id=789,nonDefaultKey=shouldBeIgnored'
      }
      const spanContextA = propagator.extract(carrier)
      expect(spanContextA._trace.tags).to.deep.equal({
        'baggage.user.id': 'capybara',
        'baggage.session.id': '987',
        'baggage.account.id': '789'
      })

      // should add baggage with case sensitive keys
      carrier = {
        'x-datadog-trace-id': '123',
        'x-datadog-parent-id': '456',
        baggage: 'user.id=capybara,sesSion.id=987,account.id=789'
      }
      const spanContextB = propagator.extract(carrier)
      expect(spanContextB._trace.tags).to.deep.equal({
        'baggage.user.id': 'capybara',
        'baggage.account.id': '789'
      })

      // should not add baggage when key list is empty
      config = new Config({
        baggageTagKeys: ''
      })
      propagator = new TextMapPropagator(config)
      const spanContextC = propagator.extract(carrier)
      expect(spanContextC._trace.tags).to.deep.equal({})

      // should not add baggage when key list is empty
      config = new Config({
        baggageTagKeys: 'customKey'
      })
      propagator = new TextMapPropagator(config)
      carrier = {
        'x-datadog-trace-id': '123',
        'x-datadog-parent-id': '456',
        baggage: 'customKey=beluga,randomKey=shouldBeIgnored'
      }
      const spanContextD = propagator.extract(carrier)
      expect(spanContextD._trace.tags).to.deep.equal({
        'baggage.customKey': 'beluga'
      })

      // should add all baggage to span tags
      config = new Config({
        baggageTagKeys: '*'
      })
      propagator = new TextMapPropagator(config)
      carrier = {
        'x-datadog-trace-id': '123',
        'x-datadog-parent-id': '456',
        baggage: 'customKey=beluga,randomKey=nothingIsIgnored'
      }
      const spanContextE = propagator.extract(carrier)
      expect(spanContextE._trace.tags).to.deep.equal({
        'baggage.customKey': 'beluga',
        'baggage.randomKey': 'nothingIsIgnored'
      })
    })

    it('should discard malformed tids', () => {
      // tid with malformed characters
      let carrier = {
        'x-datadog-trace-id': '1234567890123456789',
        'x-datadog-parent-id': '987654321',
        'x-datadog-tags': '_dd.p.tid=1234567890abcdeX'
      }
      let spanContext = propagator.extract(carrier)
      expect(spanContext.toTraceId()).to.equal(carrier['x-datadog-trace-id'])
      expect(spanContext.toSpanId()).to.equal(carrier['x-datadog-parent-id'])
      expect(spanContext._trace.tags).to.not.have.property('_dd.p.tid')

      // tid too long
      carrier = {
        'x-datadog-trace-id': '234567890123456789',
        'x-datadog-parent-id': '987654321',
        'x-datadog-tags': '_dd.p.tid=1234567890abcdef1'
      }
      spanContext = propagator.extract(carrier)
      expect(spanContext.toTraceId()).to.equal(carrier['x-datadog-trace-id'])
      expect(spanContext.toSpanId()).to.equal(carrier['x-datadog-parent-id'])
      expect(spanContext._trace.tags).to.not.have.property('_dd.p.tid')

      // tid too short
      carrier = {
        'x-datadog-trace-id': '1234567890123456789',
        'x-datadog-parent-id': '987654321',
        'x-datadog-tags': '_dd.p.tid=1234567890abcde'
      }
      spanContext = propagator.extract(carrier)
      expect(spanContext.toTraceId()).to.equal(carrier['x-datadog-trace-id'])
      expect(spanContext.toSpanId()).to.equal(carrier['x-datadog-parent-id'])
      expect(spanContext._trace.tags).to.not.have.property('_dd.p.tid')
    })

    it('should extract baggage when it is the only propagation style', () => {
      removeAllBaggageItems()
      config = new Config({
        tracePropagationStyle: {
          extract: ['baggage']
        }
      })
      propagator = new TextMapPropagator(config)
      const carrier = {
        baggage: 'foo=bar'
      }
      const spanContext = propagator.extract(carrier)
      expect(spanContext).to.equal(null)
      expect(getBaggageItem('foo')).to.equal('bar')
      expect(getAllBaggageItems()).to.deep.equal({ foo: 'bar' })
    })

    it('should convert signed IDs to unsigned', () => {
      textMap['x-datadog-trace-id'] = '-123'
      textMap['x-datadog-parent-id'] = '-456'

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext.toTraceId()).to.equal('18446744073709551493') // -123 casted to uint64
      expect(spanContext.toSpanId()).to.equal('18446744073709551160') // -456 casted to uint64
    })

    it('should return null if the carrier does not contain a trace', () => {
      const carrier = {}
      const spanContext = propagator.extract(carrier)

      expect(spanContext).to.equal(null)
    })

    it('should extract a span context with a valid sampling priority', () => {
      textMap['x-datadog-sampling-priority'] = '0'
      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._sampling.priority).to.equal(AUTO_REJECT)
    })

    it('should extract the origin', () => {
      textMap['x-datadog-origin'] = 'synthetics'
      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._trace).to.have.property('origin', 'synthetics')
    })

    it('should extract trace tags', () => {
      textMap['x-datadog-tags'] = '_dd.p.foo=bar,_dd.p.baz=qux'

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._trace.tags).to.include({
        '_dd.p.foo': 'bar',
        '_dd.p.baz': 'qux'
      })
    })

    it('should not extract trace tags if the value is too long', () => {
      textMap['x-datadog-tags'] = `_dd.p.foo=${'a'.repeat(512)}`

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._trace.tags).to.not.have.property('_dd.p.foo')
    })

    it('should not extract invalid trace tags', () => {
      textMap['x-datadog-tags'] = '_dd.p.foo=bar,_dd.p.baz,=,_dd.p.qux'

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._trace.tags).to.not.have.property('_dd.p.foo')
    })

    it('should not extract trace tags with invalid values', () => {
      textMap['x-datadog-tags'] = '_dd.p.foo=hélicoptère'

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._trace.tags).to.not.have.property('_dd.p.foo')
    })

    it('should not extract trace tags with invalid keys', () => {
      textMap['x-datadog-tags'] = '_ddupefoo=value'

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._trace.tags).to.not.have.property('_ddupefoo')
    })

    it('should not extract trace tags when disabled', () => {
      config.tagsHeaderMaxLength = 0
      textMap['x-datadog-tags'] = '_dd.p.foo=bar,_dd.p.baz=qux'

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._trace.tags).to.not.have.property('_dd.p.foo')
      expect(spanContext._trace.tags).to.not.have.property('_dd.p.baz')
    })

    it('should extract from an aws-sqsd header', () => {
      const carrier = {
        'x-aws-sqsd-attr-_datadog': JSON.stringify(textMap)
      }

      const spanContext = propagator.extract(carrier)

      expect(spanContext).to.deep.equal(createContext({
        baggageItems: {
          foo: 'bar'
        }
      }))
    })

    it('should skip extraction of datadog headers without the feature flag', () => {
      const carrier = textMap
      config.tracePropagationStyle.extract = []

      const spanContext = propagator.extract(carrier)
      expect(spanContext).to.be.null
    })

    it('should support prioritization', () => {
      config.tracePropagationStyle.extract = ['tracecontext', 'datadog']

      // No traceparent yet, will skip ahead to datadog
      const second = propagator.extract(textMap)

      expect(second.toTraceId()).to.equal(textMap['x-datadog-trace-id'])
      expect(second.toSpanId()).to.equal(textMap['x-datadog-parent-id'])

      // Add a traceparent header and it will prioritize it
      const traceId = '1111aaaa2222bbbb3333cccc4444dddd'
      const spanId = '5555eeee6666ffff'

      textMap.traceparent = `00-${traceId}-${spanId}-01`

      const first = propagator.extract(textMap)

      expect(first._traceId.toString(16)).to.equal(traceId)
      expect(first._spanId.toString(16)).to.equal(spanId)
    })

    it('should not crash with invalid traceparent', () => {
      textMap.traceparent = 'invalid'

      propagator.extract(textMap)
    })

    it('should always extract tracestate from tracecontext when trace IDs match', () => {
      textMap.traceparent = '00-0000000000000000000000000000007B-0000000000000456-01'
      textMap.tracestate = 'other=bleh,dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo;t.dm:-4'
      config.tracePropagationStyle.extract = ['datadog', 'tracecontext']

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._tracestate.get('other')).to.equal('bleh')
    })

    it('should extract the last datadog parent id from tracestate when p dd member is availible', () => {
      textMap.traceparent = '00-0000000000000000000000000000007B-0000000000000456-01'
      textMap.tracestate = 'other=bleh,dd=s:2;o:foo;p:2244eeee6666aaaa'
      config.tracePropagationStyle.extract = ['tracecontext']

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._trace.tags).to.have.property('_dd.parent_id', '2244eeee6666aaaa')
    })

    it('should preserve trace header tid when tracestate contains an inconsistent tid', () => {
      textMap.traceparent = '00-640cfd8d00000000abcdefab12345678-000000003ade68b1-01'
      textMap.tracestate = 'dd=t.tid:640cfd8d0000ffff'
      config.tracePropagationStyle.extract = ['tracecontext']

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._traceId.toString(16)).to.equal('640cfd8d00000000abcdefab12345678')
      expect(spanContext._trace.tags).to.have.property('_dd.p.tid', '640cfd8d00000000')
    })

    it('should preserve trace header tid when tracestate contains a malformed tid', () => {
      textMap.traceparent = '00-640cfd8d00000000abcdefab12345678-000000003ade68b1-01'
      textMap.tracestate = 'dd=t.tid:XXXX'
      config.tracePropagationStyle.extract = ['tracecontext']

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._traceId.toString(16)).to.equal('640cfd8d00000000abcdefab12345678')
      expect(spanContext._trace.tags).to.have.property('_dd.p.tid', '640cfd8d00000000')
    })

    it('should set the last datadog parent id to zero when p: is NOT in the tracestate', () => {
      textMap.traceparent = '00-0000000000000000000000000000007B-0000000000000456-01'
      textMap.tracestate = 'other=gg,dd=s:-1;'
      config.tracePropagationStyle.extract = ['tracecontext']

      const carrier = textMap
      const spanContext = propagator.extract(carrier)
      expect(spanContext._trace.tags).to.not.have.property('_dd.parent_id')
    })

    it('should not extract tracestate from tracecontext when trace IDs don\'t match', () => {
      textMap.traceparent = '00-00000000000000000000000000000789-0000000000000456-01'
      textMap.tracestate = 'other=bleh,dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo;t.dm:-4'
      config.tracePropagationStyle.extract = ['datadog', 'tracecontext']

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._tracestate).to.be.undefined
    })

    it('should not extract tracestate from tracecontext when configured to extract first', () => {
      textMap.traceparent = '00-0000000000000000000000000000007B-0000000000000456-01'
      textMap.tracestate = 'other=bleh,dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo;t.dm:-4'
      config.tracePropagationStyle.extract = ['datadog', 'tracecontext']
      config.tracePropagationExtractFirst = true

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._tracestate).to.be.undefined
    })

    it('extracts span_id from tracecontext headers and stores datadog parent-id in trace_distributed_tags', () => {
      textMap['x-datadog-trace-id'] = '61185'
      textMap['x-datadog-parent-id'] = '15'
      textMap.traceparent = '00-0000000000000000000000000000ef01-0000000000011ef0-01'
      config.tracePropagationStyle.extract = ['datadog', 'tracecontext']

      const carrier = textMap
      const spanContext = propagator.extract(carrier)
      expect(parseInt(spanContext._spanId.toString(), 16)).to.equal(73456)
      expect(parseInt(spanContext._traceId.toString(), 16)).to.equal(61185)
      expect(spanContext._trace.tags).to.have.property('_dd.parent_id', '000000000000000f')
    })

    it('extracts span_id from tracecontext headers and stores p value from tracestate in trace_distributed_tags',
      () => {
        textMap['x-datadog-trace-id'] = '61185'
        textMap['x-datadog-parent-id'] = '15'
        textMap.traceparent = '00-0000000000000000000000000000ef01-0000000000011ef0-01'
        textMap.tracestate = 'other=bleh,dd=p:0000000000000001;s:2;o:foo;t.dm:-4'
        config.tracePropagationStyle.extract = ['datadog', 'tracecontext']

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        expect(parseInt(spanContext._spanId.toString(), 16)).to.equal(73456)
        expect(parseInt(spanContext._traceId.toString(), 16)).to.equal(61185)
        expect(spanContext._trace.tags).to.have.property('_dd.parent_id', '0000000000000001')
      })

    it('should publish spanContext and carrier', () => {
      const onSpanExtract = sinon.stub()
      extractCh.subscribe(onSpanExtract)

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      try {
        expect(onSpanExtract).to.be.calledOnce
        expect(onSpanExtract.firstCall.args[0]).to.be.deep.equal({ spanContext, carrier })
      } finally {
        extractCh.unsubscribe(onSpanExtract)
      }
    })

    describe('baggage telemetry metrics', () => {
      let tracerMetrics

      beforeEach(() => {
        // Get the mocked tracer metrics instance
        tracerMetrics = telemetryMetrics.manager.namespace('tracers')
        // Reset baggage between tests
        removeAllBaggageItems()
      })

      it('should track baggage extraction metric when baggage is successfully extracted', () => {
        const carrier = {
          'x-datadog-trace-id': '123',
          'x-datadog-parent-id': '456',
          baggage: 'test-key=test-value'
        }

        propagator.extract(carrier)

        expect(tracerMetrics.count).to.have.been.calledWith('context_header_style.extracted', ['header_style:baggage'])
        expect(tracerMetrics.count().inc).to.have.been.called
        expect(getBaggageItem('test-key')).to.equal('test-value')
      })

      it('should track malformed metric when baggage has empty key', () => {
        const carrier = {
          'x-datadog-trace-id': '123',
          'x-datadog-parent-id': '456',
          baggage: '=value-without-key'
        }

        propagator.extract(carrier)

        expect(tracerMetrics.count).to.have.been.calledWith('context_header_style.malformed', ['header_style:baggage'])
        expect(tracerMetrics.count().inc).to.have.been.called
        expect(getAllBaggageItems()).to.deep.equal({})
      })
    })

    it('should create span links when traces have inconsistent traceids', () => {
      // Add a traceparent header and it will prioritize it
      const traceId = '1111aaaa2222bbbb3333cccc4444dddd'
      const spanId = '5555eeee6666ffff'
      textMap.traceparent = `00-${traceId}-${spanId}-01`

      config.tracePropagationStyle.extract = ['tracecontext', 'datadog']

      const first = propagator.extract(textMap)

      expect(first._links.length).to.equal(1)
      expect(first._links[0].context.toTraceId()).to.equal(textMap['x-datadog-trace-id'])
      expect(first._links[0].context.toSpanId()).to.equal(textMap['x-datadog-parent-id'])
      expect(first._links[0].attributes.reason).to.equal('terminated_context')
      expect(first._links[0].attributes.context_headers).to.equal('datadog')
    })

    it('should log extraction', () => {
      const carrier = textMap

      propagator.extract(carrier)

      expect(log.debug).to.have.been.called
      expect(log.debug.firstCall.args[0]()).to.equal([
        'Extract from carrier (datadog, tracecontext, baggage):',
        '{"x-datadog-trace-id":"123","x-datadog-parent-id":"456"}.'
      ].join(' '))
    })

    describe('with B3 propagation as multiple headers', () => {
      beforeEach(() => {
        config.tracePropagationStyle.extract = ['b3multi']

        delete textMap['x-datadog-trace-id']
        delete textMap['x-datadog-parent-id']
      })

      it('should extract the headers', () => {
        textMap['x-b3-traceid'] = '0000000000000123'
        textMap['x-b3-spanid'] = '0000000000000456'
        textMap['x-b3-sampled'] = '1'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.deep.equal(createContext({
          traceId: id('123', 16),
          spanId: id('456', 16),
          sampling: {
            priority: AUTO_KEEP
          }
        }))
      })

      it('should support unsampled traces', () => {
        textMap['x-b3-sampled'] = '0'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._sampling.priority).to.equal(AUTO_REJECT)
      })

      it('should support sampled traces', () => {
        textMap['x-b3-sampled'] = '1'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._sampling.priority).to.equal(AUTO_KEEP)
      })

      it('should support the debug flag', () => {
        textMap['x-b3-flags'] = '1'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._sampling.priority).to.equal(USER_KEEP)
      })

      it('should skip extraction without the feature flag', () => {
        textMap['x-b3-traceid'] = '0000000000000123'
        textMap['x-b3-spanid'] = '0000000000000456'

        config.tracePropagationStyle.extract = []

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.be.null
      })

      it('should log extraction', () => {
        textMap['x-b3-traceid'] = '0000000000000123'
        textMap['x-b3-spanid'] = '0000000000000456'

        propagator.extract(textMap)

        expect(log.debug).to.have.been.called
        expect(log.debug.firstCall.args[0]()).to.equal([
          'Extract from carrier (b3multi):',
          '{"x-b3-traceid":"0000000000000123","x-b3-spanid":"0000000000000456"}.'
        ].join(' '))
      })
    })

    describe('with B3 propagation as a single header', () => {
      beforeEach(() => {
        config.tracePropagationStyle.extract = ['b3 single header']

        delete textMap['x-datadog-trace-id']
        delete textMap['x-datadog-parent-id']
      })

      it('should extract the header', () => {
        textMap.b3 = '0000000000000123-0000000000000456'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.deep.equal(createContext({
          traceId: id('123', 16),
          spanId: id('456', 16)
        }))
      })

      it('should extract sampling', () => {
        textMap.b3 = '0000000000000123-0000000000000456-1'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.deep.equal(createContext({
          traceId: id('123', 16),
          spanId: id('456', 16),
          sampling: {
            priority: AUTO_KEEP
          }
        }))
      })

      it('should support the full syntax', () => {
        textMap.b3 = '0000000000000123-0000000000000456-1-0000000000000789'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.deep.equal(createContext({
          traceId: id('123', 16),
          spanId: id('456', 16),
          sampling: {
            priority: AUTO_KEEP
          }
        }))
      })

      it('should support unsampled traces', () => {
        textMap.b3 = '0'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._sampling.priority).to.equal(AUTO_REJECT)
      })

      it('should support sampled traces', () => {
        textMap.b3 = '1'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._sampling.priority).to.equal(AUTO_KEEP)
      })

      it('should support the debug flag', () => {
        textMap.b3 = 'd'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._sampling.priority).to.equal(USER_KEEP)
      })

      it('should skip extraction without the feature flag', () => {
        textMap.b3 = '0000000000000123-0000000000000456-1-0000000000000789'

        config.tracePropagationStyle.extract = []

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.be.null
      })

      it('should support 128-bit trace IDs', () => {
        textMap.b3 = '00000000000002340000000000000123-0000000000000456'

        config.traceId128BitGenerationEnabled = true

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.deep.equal(createContext({
          traceId: id('00000000000002340000000000000123', 16),
          spanId: id('456', 16),
          trace: {
            tags: {
              '_dd.p.tid': '0000000000000234'
            }
          }
        }))
      })

      it('should skip extracting upper bits for 64-bit trace IDs', () => {
        textMap.b3 = '00000000000000000000000000000123-0000000000000456'

        config.traceId128BitGenerationEnabled = true

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.deep.equal(createContext({
          traceId: id('00000000000000000000000000000123', 16),
          spanId: id('456', 16)
        }))
      })

      it('should log extraction', () => {
        textMap.b3 = '0000000000000123-0000000000000456'

        propagator.extract(textMap)

        expect(log.debug).to.have.been.called
        expect(log.debug.firstCall.args[0]()).to.equal(
          `Extract from carrier (b3 single header): {"b3":"${textMap.b3}"}.`
        )
      })
    })

    describe('With traceparent propagation as single header', () => {
      beforeEach(() => {
        delete textMap['x-datadog-trace-id']
        delete textMap['x-datadog-parent-id']
      })

      it('should skip extraction without the feature flag', () => {
        textMap.traceparent = '00-000000000000000000000000000004d2-000000000000162e-01'
        config.tracePropagationStyle.extract = []

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        expect(spanContext).to.be.null
      })

      it('should extract the header', () => {
        textMap.traceparent = '00-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01'
        textMap.tracestate = 'other=bleh,dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo;t.dm:-4'
        config.tracePropagationStyle.extract = ['tracecontext']

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        expect(spanContext._traceId.toString(16)).to.equal('1111aaaa2222bbbb3333cccc4444dddd')
        expect(spanContext._spanId.toString(16)).to.equal('5555eeee6666ffff')
        expect(spanContext._sampling.priority).to.equal(USER_KEEP)
        expect(spanContext._trace.origin).to.equal('foo')
        expect(spanContext._trace.tags).to.have.property(
          '_dd.p.foo_bar_baz_',
          'abc_!@#$%^&*()_+`-='
        )
        expect(spanContext._trace.tags['_dd.p.dm']).to.eql('-4')
      })

      it('should extract a 128-bit trace ID', () => {
        textMap.traceparent = '00-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01'
        config.tracePropagationStyle.extract = ['tracecontext']
        config.traceId128BitGenerationEnabled = true

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        expect(spanContext._traceId.toString(16)).to.equal('1111aaaa2222bbbb3333cccc4444dddd')
        expect(spanContext._trace.tags).to.have.property('_dd.p.tid', '1111aaaa2222bbbb')
      })

      it('should skip extracting upper bits for 64-bit trace IDs', () => {
        textMap.traceparent = '00-00000000000000003333cccc4444dddd-5555eeee6666ffff-01'
        config.tracePropagationStyle.extract = ['tracecontext']
        config.traceId128BitGenerationEnabled = true

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext._traceId.toString(16)).to.equal('00000000000000003333cccc4444dddd')
        expect(spanContext._trace.tags).to.not.have.property('_dd.p.tid')
      })

      it('should propagate the version', () => {
        textMap.traceparent = '01-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01'
        textMap.tracestate = 'other=bleh,dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo;t.dm:-4'
        config.tracePropagationStyle.extract = ['tracecontext']

        const carrier = {}
        const spanContext = propagator.extract(textMap)

        propagator.inject(spanContext, carrier)

        expect(carrier.traceparent).to.match(/^01/)
        expect(carrier['x-datadog-tags']).to.include('_dd.p.dm=-4')
        expect(spanContext._trace.tags['_dd.p.dm']).to.eql('-4')
      })

      it('should propagate other vendors', () => {
        textMap.traceparent = '01-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01'
        textMap.tracestate = 'other=bleh,dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo;t.dm:-4'
        config.tracePropagationStyle.extract = ['tracecontext']

        const carrier = {}
        const spanContext = propagator.extract(textMap)

        propagator.inject(spanContext, carrier)

        expect(carrier.tracestate).to.include('other=bleh')
      })

      it('should propagate last datadog id', () => {
        textMap.traceparent = '01-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01'
        textMap.tracestate = 'other=bleh,dd=s:2;o:foo;t.dm:-4;p:4444eeee6666aaaa'
        config.tracePropagationStyle.extract = ['tracecontext']

        const carrier = {}
        const spanContext = propagator.extract(textMap)
        // Ensure the span context is marked as remote (i.e. not generated by the current process)
        expect(spanContext._isRemote).to.equal(true)

        propagator.inject(spanContext, carrier)

        expect(carrier.tracestate).to.include('p:4444eeee6666aaaa')
      })

      it('should fix _dd.p.dm if invalid (non-hyphenated) input is received', () => {
        textMap.traceparent = '01-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01'
        textMap.tracestate = 'other=bleh,dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo;t.dm:4'
        config.tracePropagationStyle.extract = ['tracecontext']

        const carrier = {}
        const spanContext = propagator.extract(textMap)

        propagator.inject(spanContext, carrier)

        expect(carrier['x-datadog-tags']).to.include('_dd.p.dm=-4')
        expect(spanContext._trace.tags['_dd.p.dm']).to.eql('-4')
      })

      it('should maintain hyphen prefix when a default mechanism of 0 is received', () => {
        textMap.traceparent = '01-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01'
        textMap.tracestate = 'other=bleh,dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo;t.dm:-0'
        config.tracePropagationStyle.extract = ['tracecontext']

        const carrier = {}
        const spanContext = propagator.extract(textMap)

        propagator.inject(spanContext, carrier)

        expect(carrier['x-datadog-tags']).to.include('_dd.p.dm=-0')
        expect(spanContext._trace.tags['_dd.p.dm']).to.eql('-0')
      })

      it('should log extraction', () => {
        const traceparent = textMap.traceparent = '00-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01'
        const tracestate = textMap.tracestate = 'other=bleh,dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo;t.dm:-4'

        config.tracePropagationStyle.extract = ['tracecontext']

        propagator.extract(textMap)

        expect(log.debug).to.have.been.called
        expect(log.debug.firstCall.args[0]()).to.equal([
          'Extract from carrier (tracecontext):',
          `{"traceparent":"${traceparent}","tracestate":"${tracestate}"}.`
        ].join(' '))
      })
    })

    describe('tracePropagationBehaviorExtract', () => {
      let traceId
      let spanId

      beforeEach(() => {
        traceId = '1111aaaa2222bbbb3333cccc4444dddd'
        spanId = '5555eeee6666ffff'
        textMap = {
          'x-datadog-trace-id': '123',
          'x-datadog-parent-id': '456',
          'ot-baggage-foo': 'bar',
          traceparent: `00-${traceId}-${spanId}-01`,
          baggage: 'foo=bar'
        }
      })

      it('should reset span links when Trace_Propagation_Behavior_Extract is set to ignore', () => {
        process.env.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT = 'ignore'
        config = new Config({
          tracePropagationStyle: {
            extract: ['tracecontext', 'datadog']
          }
        })
        propagator = new TextMapPropagator(config)
        const extractedContext = propagator.extract(textMap)

        // No span links should occur when we return from extract
        expect(extractedContext._links.length).to.equal(0)
      })

      it('should set span link to extracted trace when Trace_Propagation_Behavior_Extract is set to restart', () => {
        process.env.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT = 'restart'
        config = new Config({
          tracePropagationStyle: {
            extract: ['tracecontext', 'datadog']
          }
        })
        propagator = new TextMapPropagator(config)
        const extractedContext = propagator.extract(textMap)

        // Expect to see span links related to the extracted span
        expect(extractedContext._links.length).to.equal(1)
        expect(extractedContext._links[0].context.toTraceId(true)).to.equal(traceId)
        expect(extractedContext._links[0].context.toSpanId(true)).to.equal(spanId)
        expect(extractedContext._links[0].attributes.reason).to.equal('propagation_behavior_extract')
        expect(extractedContext._links[0].attributes.context_headers).to.equal('tracecontext')
      })

      it('should not extract baggage when Trace_Propagation_Behavior_Extract is set to ignore', () => {
        process.env.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT = 'ignore'
        config = new Config({
          tracePropagationStyle: {
            extract: ['tracecontext', 'datadog', 'baggage']
          }
        })
        textMap = {
          'x-datadog-trace-id': '123',
          'x-datadog-parent-id': '456',
          traceparent: `00-${traceId}-${spanId}-01`,
          baggage: 'foo=bar'
        }
        propagator = new TextMapPropagator(config)
        propagator.extract(textMap)

        expect(getAllBaggageItems()).to.deep.equal({})
      })
    })
  })
})
