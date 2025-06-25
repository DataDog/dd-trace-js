'use strict'

const t = require('tap')
require('../../setup/core')

const Config = require('../../../src/config')
const id = require('../../../src/id')
const SpanContext = require('../../../src/opentracing/span_context')
const TraceState = require('../../../src/opentracing/propagation/tracestate')
const { channel } = require('dc-polyfill')
const { setBaggageItem, getBaggageItem, getAllBaggageItems, removeAllBaggageItems } = require('../../../src/baggage')

const { AUTO_KEEP, AUTO_REJECT, USER_KEEP } = require('../../../../../ext/priority')
const { SAMPLING_MECHANISM_MANUAL } = require('../../../src/constants')
const { expect } = require('chai')

const injectCh = channel('dd-trace:span:inject')
const extractCh = channel('dd-trace:span:extract')

t.test('TextMapPropagator', t => {
  let TextMapPropagator
  let propagator
  let textMap
  let baggageItems
  let config
  let log

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

  t.beforeEach(() => {
    log = {
      debug: sinon.spy()
    }
    TextMapPropagator = proxyquire('../src/opentracing/propagation/text_map', {
      '../../log': log
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

  t.test('inject', t => {
    t.beforeEach(() => {
      baggageItems = {
        foo: 'bar'
      }
    })

    t.test('should not crash without spanContext', t => {
      const carrier = {}
      propagator.inject(null, carrier)
      t.end()
    })

    t.test('should not crash without carrier', t => {
      const spanContext = createContext()
      propagator.inject(spanContext, null)
      t.end()
    })

    t.test('should inject the span context into the carrier', t => {
      const carrier = {}
      const spanContext = createContext()

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('x-datadog-trace-id', '123')
      expect(carrier).to.have.property('x-datadog-parent-id', '456')
      expect(carrier).to.have.property('ot-baggage-foo', 'bar')
      expect(carrier.baggage).to.be.undefined
      t.end()
    })

    t.test('should handle non-string values', t => {
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
      t.end()
    })

    t.test('should handle special characters in baggage', t => {
      const carrier = {}
      setBaggageItem('",;\\()/:<=>?@[]{}🐶é我', '",;\\🐶é我')
      propagator.inject(undefined, carrier)
      // eslint-disable-next-line @stylistic/max-len
      expect(carrier.baggage).to.be.equal('%22%2C%3B%5C%28%29%2F%3A%3C%3D%3E%3F%40%5B%5D%7B%7D%F0%9F%90%B6%C3%A9%E6%88%91=%22%2C%3B%5C%F0%9F%90%B6%C3%A9%E6%88%91')
      t.end()
    })

    t.test('should drop excess baggage items when there are too many pairs', t => {
      const carrier = {}
      for (let i = 0; i < config.baggageMaxItems + 1; i++) {
        setBaggageItem(`key-${i}`, i)
      }
      propagator.inject(undefined, carrier)
      expect(carrier.baggage.split(',').length).to.equal(config.baggageMaxItems)
      t.end()
    })

    t.test('should drop excess baggage items when the resulting baggage header contains many bytes', t => {
      const carrier = {}
      setBaggageItem('raccoon', 'chunky')
      setBaggageItem('foo', Buffer.alloc(config.baggageMaxBytes).toString())

      propagator.inject(undefined, carrier)
      expect(carrier.baggage).to.equal('raccoon=chunky')
      t.end()
    })

    t.test('should inject an existing sampling priority', t => {
      const carrier = {}
      const spanContext = createContext({
        sampling: {
          priority: 0
        }
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('x-datadog-sampling-priority', '0')
      t.end()
    })

    t.test('should inject the origin', t => {
      const carrier = {}
      const spanContext = createContext({
        trace: {
          origin: 'synthetics',
          tags: {}
        }
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('x-datadog-origin', 'synthetics')
      t.end()
    })

    t.test('should inject trace tags prefixed for propagation', t => {
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
      t.end()
    })

    t.test('should drop trace tags if too large', t => {
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
      t.end()
    })

    t.test('should drop trace tags if value is invalid', t => {
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
      t.end()
    })

    t.test('should drop trace tags if key is invalid', t => {
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
      t.end()
    })

    t.test('should drop trace tags if disabled', t => {
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
      t.end()
    })

    t.test('should inject the trace B3 headers', t => {
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
      t.end()
    })

    t.test('should inject the 128-bit trace ID in B3 headers when available as tag', t => {
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
      t.end()
    })

    t.test('should inject the 128-bit trace ID in B3 headers when available as ID', t => {
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
      t.end()
    })

    t.test('should inject the traceparent header', t => {
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
      t.end()
    })

    t.test('should skip injection of B3 headers without the feature flag', t => {
      const carrier = {}
      const spanContext = createContext({
        traceId: id('0000000000000123'),
        spanId: id('0000000000000456')
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.not.have.property('x-b3-traceid')
      t.end()
    })

    t.test('should skip injection of traceparent header without the feature flag', t => {
      const carrier = {}
      const spanContext = createContext({
        traceId: id('0000000000000123'),
        spanId: id('0000000000000456')
      })

      config.tracePropagationStyle.inject = []

      propagator.inject(spanContext, carrier)

      expect(carrier).to.not.have.property('traceparent')
      t.end()
    })

    t.test('should skip injection of datadog headers without the feature flag', t => {
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
      t.end()
    })

    t.test('should publish spanContext and carrier', t => {
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
      t.end()
    })
    t.end()
  })

  t.test('extract', t => {
    t.test('should extract a span context from the carrier', t => {
      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext.toTraceId()).to.equal(carrier['x-datadog-trace-id'])
      expect(spanContext.toSpanId()).to.equal(carrier['x-datadog-parent-id'])
      expect(spanContext._baggageItems.foo).to.equal(carrier['ot-baggage-foo'])
      expect(spanContext._baggageItems).to.deep.equal({ foo: 'bar' })
      expect(getAllBaggageItems()).to.deep.equal({ foo: 'bar' })
      expect(spanContext._isRemote).to.equal(true)
      t.end()
    })

    t.test('should extract opentracing baggage when baggage is not a propagation style ', t => {
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
      t.end()
    })

    t.test('should extract otel baggage items with special characters', t => {
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
      t.end()
    })

    t.test('should not extract baggage when the header is malformed', t => {
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
      t.end()
    })

    t.test('should add baggage items to span tags', t => {
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
      t.end()
    })

    t.test('should discard malformed tids', t => {
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
      t.end()
    })

    t.test('should extract baggage when it is the only propagation style', t => {
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
      t.end()
    })

    t.test('should convert signed IDs to unsigned', t => {
      textMap['x-datadog-trace-id'] = '-123'
      textMap['x-datadog-parent-id'] = '-456'

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext.toTraceId()).to.equal('18446744073709551493') // -123 casted to uint64
      expect(spanContext.toSpanId()).to.equal('18446744073709551160') // -456 casted to uint64
      t.end()
    })

    t.test('should return null if the carrier does not contain a trace', t => {
      const carrier = {}
      const spanContext = propagator.extract(carrier)

      expect(spanContext).to.equal(null)
      t.end()
    })

    t.test('should extract a span context with a valid sampling priority', t => {
      textMap['x-datadog-sampling-priority'] = '0'
      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._sampling.priority).to.equal(AUTO_REJECT)
      t.end()
    })

    t.test('should extract the origin', t => {
      textMap['x-datadog-origin'] = 'synthetics'
      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._trace).to.have.property('origin', 'synthetics')
      t.end()
    })

    t.test('should extract trace tags', t => {
      textMap['x-datadog-tags'] = '_dd.p.foo=bar,_dd.p.baz=qux'

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._trace.tags).to.include({
        '_dd.p.foo': 'bar',
        '_dd.p.baz': 'qux'
      })
      t.end()
    })

    t.test('should not extract trace tags if the value is too long', t => {
      textMap['x-datadog-tags'] = `_dd.p.foo=${'a'.repeat(512)}`

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._trace.tags).to.not.have.property('_dd.p.foo')
      t.end()
    })

    t.test('should not extract invalid trace tags', t => {
      textMap['x-datadog-tags'] = '_dd.p.foo=bar,_dd.p.baz,=,_dd.p.qux'

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._trace.tags).to.not.have.property('_dd.p.foo')
      t.end()
    })

    t.test('should not extract trace tags with invalid values', t => {
      textMap['x-datadog-tags'] = '_dd.p.foo=hélicoptère'

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._trace.tags).to.not.have.property('_dd.p.foo')
      t.end()
    })

    t.test('should not extract trace tags with invalid keys', t => {
      textMap['x-datadog-tags'] = '_ddupefoo=value'

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._trace.tags).to.not.have.property('_ddupefoo')
      t.end()
    })

    t.test('should not extract trace tags when disabled', t => {
      config.tagsHeaderMaxLength = 0
      textMap['x-datadog-tags'] = '_dd.p.foo=bar,_dd.p.baz=qux'

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._trace.tags).to.not.have.property('_dd.p.foo')
      expect(spanContext._trace.tags).to.not.have.property('_dd.p.baz')
      t.end()
    })

    t.test('should extract from an aws-sqsd header', t => {
      const carrier = {
        'x-aws-sqsd-attr-_datadog': JSON.stringify(textMap)
      }

      const spanContext = propagator.extract(carrier)

      expect(spanContext).to.deep.equal(createContext({
        baggageItems: {
          foo: 'bar'
        }
      }))
      t.end()
    })

    t.test('should skip extraction of datadog headers without the feature flag', t => {
      const carrier = textMap
      config.tracePropagationStyle.extract = []

      const spanContext = propagator.extract(carrier)
      expect(spanContext).to.be.null
      t.end()
    })

    t.test('should support prioritization', t => {
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
      t.end()
    })

    t.test('should not crash with invalid traceparent', t => {
      textMap.traceparent = 'invalid'

      propagator.extract(textMap)
      t.end()
    })

    t.test('should always extract tracestate from tracecontext when trace IDs match', t => {
      textMap.traceparent = '00-0000000000000000000000000000007B-0000000000000456-01'
      textMap.tracestate = 'other=bleh,dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo;t.dm:-4'
      config.tracePropagationStyle.extract = ['datadog', 'tracecontext']

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._tracestate.get('other')).to.equal('bleh')
      t.end()
    })

    t.test('should extract the last datadog parent id from tracestate when p dd member is availible', t => {
      textMap.traceparent = '00-0000000000000000000000000000007B-0000000000000456-01'
      textMap.tracestate = 'other=bleh,dd=s:2;o:foo;p:2244eeee6666aaaa'
      config.tracePropagationStyle.extract = ['tracecontext']

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._trace.tags).to.have.property('_dd.parent_id', '2244eeee6666aaaa')
      t.end()
    })

    t.test('should preserve trace header tid when tracestate contains an inconsistent tid', t => {
      textMap.traceparent = '00-640cfd8d00000000abcdefab12345678-000000003ade68b1-01'
      textMap.tracestate = 'dd=t.tid:640cfd8d0000ffff'
      config.tracePropagationStyle.extract = ['tracecontext']

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._traceId.toString(16)).to.equal('640cfd8d00000000abcdefab12345678')
      expect(spanContext._trace.tags).to.have.property('_dd.p.tid', '640cfd8d00000000')
      t.end()
    })

    t.test('should preserve trace header tid when tracestate contains a malformed tid', t => {
      textMap.traceparent = '00-640cfd8d00000000abcdefab12345678-000000003ade68b1-01'
      textMap.tracestate = 'dd=t.tid:XXXX'
      config.tracePropagationStyle.extract = ['tracecontext']

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._traceId.toString(16)).to.equal('640cfd8d00000000abcdefab12345678')
      expect(spanContext._trace.tags).to.have.property('_dd.p.tid', '640cfd8d00000000')
      t.end()
    })

    t.test('should set the last datadog parent id to zero when p: is NOT in the tracestate', t => {
      textMap.traceparent = '00-0000000000000000000000000000007B-0000000000000456-01'
      textMap.tracestate = 'other=gg,dd=s:-1;'
      config.tracePropagationStyle.extract = ['tracecontext']

      const carrier = textMap
      const spanContext = propagator.extract(carrier)
      expect(spanContext._trace.tags).to.not.have.property('_dd.parent_id')
      t.end()
    })

    t.test('should not extract tracestate from tracecontext when trace IDs don\'t match', t => {
      textMap.traceparent = '00-00000000000000000000000000000789-0000000000000456-01'
      textMap.tracestate = 'other=bleh,dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo;t.dm:-4'
      config.tracePropagationStyle.extract = ['datadog', 'tracecontext']

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._tracestate).to.be.undefined
      t.end()
    })

    t.test('should not extract tracestate from tracecontext when configured to extract first', t => {
      textMap.traceparent = '00-0000000000000000000000000000007B-0000000000000456-01'
      textMap.tracestate = 'other=bleh,dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo;t.dm:-4'
      config.tracePropagationStyle.extract = ['datadog', 'tracecontext']
      config.tracePropagationExtractFirst = true

      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._tracestate).to.be.undefined
      t.end()
    })

    t.test('extracts span_id from tracecontext headers and stores datadog parent-id in trace_distributed_tags', t => {
      textMap['x-datadog-trace-id'] = '61185'
      textMap['x-datadog-parent-id'] = '15'
      textMap.traceparent = '00-0000000000000000000000000000ef01-0000000000011ef0-01'
      config.tracePropagationStyle.extract = ['datadog', 'tracecontext']

      const carrier = textMap
      const spanContext = propagator.extract(carrier)
      expect(parseInt(spanContext._spanId.toString(), 16)).to.equal(73456)
      expect(parseInt(spanContext._traceId.toString(), 16)).to.equal(61185)
      expect(spanContext._trace.tags).to.have.property('_dd.parent_id', '000000000000000f')
      t.end()
    })

    t.test('extracts span_id from tracecontext headers and stores p value from tracestate in trace_distributed_tags',
      t => {
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
        t.end()
      })

    t.test('should publish spanContext and carrier', t => {
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
      t.end()
    })

    t.test('should create span links when traces have inconsistent traceids', t => {
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
      t.end()
    })

    t.test('should log extraction', t => {
      const carrier = textMap

      propagator.extract(carrier)

      expect(log.debug).to.have.been.called
      expect(log.debug.firstCall.args[0]()).to.equal([
        'Extract from carrier (datadog, tracecontext, baggage):',
        '{"x-datadog-trace-id":"123","x-datadog-parent-id":"456"}.'
      ].join(' '))
      t.end()
    })

    t.test('with B3 propagation as multiple headers', t => {
      t.beforeEach(() => {
        config.tracePropagationStyle.extract = ['b3multi']

        delete textMap['x-datadog-trace-id']
        delete textMap['x-datadog-parent-id']
      })

      t.test('should extract the headers', t => {
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
        t.end()
      })

      t.test('should support unsampled traces', t => {
        textMap['x-b3-sampled'] = '0'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._sampling.priority).to.equal(AUTO_REJECT)
        t.end()
      })

      t.test('should support sampled traces', t => {
        textMap['x-b3-sampled'] = '1'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._sampling.priority).to.equal(AUTO_KEEP)
        t.end()
      })

      t.test('should support the debug flag', t => {
        textMap['x-b3-flags'] = '1'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._sampling.priority).to.equal(USER_KEEP)
        t.end()
      })

      t.test('should skip extraction without the feature flag', t => {
        textMap['x-b3-traceid'] = '0000000000000123'
        textMap['x-b3-spanid'] = '0000000000000456'

        config.tracePropagationStyle.extract = []

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.be.null
        t.end()
      })

      t.test('should log extraction', t => {
        textMap['x-b3-traceid'] = '0000000000000123'
        textMap['x-b3-spanid'] = '0000000000000456'

        propagator.extract(textMap)

        expect(log.debug).to.have.been.called
        expect(log.debug.firstCall.args[0]()).to.equal([
          'Extract from carrier (b3multi):',
          '{"x-b3-traceid":"0000000000000123","x-b3-spanid":"0000000000000456"}.'
        ].join(' '))
        t.end()
      })
      t.end()
    })

    t.test('with B3 propagation as a single header', t => {
      t.beforeEach(() => {
        config.tracePropagationStyle.extract = ['b3 single header']

        delete textMap['x-datadog-trace-id']
        delete textMap['x-datadog-parent-id']
      })

      t.test('should extract the header', t => {
        textMap.b3 = '0000000000000123-0000000000000456'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.deep.equal(createContext({
          traceId: id('123', 16),
          spanId: id('456', 16)
        }))
        t.end()
      })

      t.test('should extract sampling', t => {
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
        t.end()
      })

      t.test('should support the full syntax', t => {
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
        t.end()
      })

      t.test('should support unsampled traces', t => {
        textMap.b3 = '0'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._sampling.priority).to.equal(AUTO_REJECT)
        t.end()
      })

      t.test('should support sampled traces', t => {
        textMap.b3 = '1'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._sampling.priority).to.equal(AUTO_KEEP)
        t.end()
      })

      t.test('should support the debug flag', t => {
        textMap.b3 = 'd'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._sampling.priority).to.equal(USER_KEEP)
        t.end()
      })

      t.test('should skip extraction without the feature flag', t => {
        textMap.b3 = '0000000000000123-0000000000000456-1-0000000000000789'

        config.tracePropagationStyle.extract = []

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.be.null
        t.end()
      })

      t.test('should support 128-bit trace IDs', t => {
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
        t.end()
      })

      t.test('should skip extracting upper bits for 64-bit trace IDs', t => {
        textMap.b3 = '00000000000000000000000000000123-0000000000000456'

        config.traceId128BitGenerationEnabled = true

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.deep.equal(createContext({
          traceId: id('00000000000000000000000000000123', 16),
          spanId: id('456', 16)
        }))
        t.end()
      })

      t.test('should log extraction', t => {
        textMap.b3 = '0000000000000123-0000000000000456'

        propagator.extract(textMap)

        expect(log.debug).to.have.been.called
        expect(log.debug.firstCall.args[0]()).to.equal(
          `Extract from carrier (b3 single header): {"b3":"${textMap.b3}"}.`
        )
        t.end()
      })
      t.end()
    })

    t.test('With traceparent propagation as single header', t => {
      t.beforeEach(() => {
        delete textMap['x-datadog-trace-id']
        delete textMap['x-datadog-parent-id']
      })

      t.test('should skip extraction without the feature flag', t => {
        textMap.traceparent = '00-000000000000000000000000000004d2-000000000000162e-01'
        config.tracePropagationStyle.extract = []

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        expect(spanContext).to.be.null
        t.end()
      })

      t.test('should extract the header', t => {
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
        t.end()
      })

      t.test('should extract a 128-bit trace ID', t => {
        textMap.traceparent = '00-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01'
        config.tracePropagationStyle.extract = ['tracecontext']
        config.traceId128BitGenerationEnabled = true

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        expect(spanContext._traceId.toString(16)).to.equal('1111aaaa2222bbbb3333cccc4444dddd')
        expect(spanContext._trace.tags).to.have.property('_dd.p.tid', '1111aaaa2222bbbb')
        t.end()
      })

      t.test('should skip extracting upper bits for 64-bit trace IDs', t => {
        textMap.traceparent = '00-00000000000000003333cccc4444dddd-5555eeee6666ffff-01'
        config.tracePropagationStyle.extract = ['tracecontext']
        config.traceId128BitGenerationEnabled = true

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext._traceId.toString(16)).to.equal('00000000000000003333cccc4444dddd')
        expect(spanContext._trace.tags).to.not.have.property('_dd.p.tid')
        t.end()
      })

      t.test('should propagate the version', t => {
        textMap.traceparent = '01-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01'
        textMap.tracestate = 'other=bleh,dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo;t.dm:-4'
        config.tracePropagationStyle.extract = ['tracecontext']

        const carrier = {}
        const spanContext = propagator.extract(textMap)

        propagator.inject(spanContext, carrier)

        expect(carrier.traceparent).to.match(/^01/)
        expect(carrier['x-datadog-tags']).to.include('_dd.p.dm=-4')
        expect(spanContext._trace.tags['_dd.p.dm']).to.eql('-4')
        t.end()
      })

      t.test('should propagate other vendors', t => {
        textMap.traceparent = '01-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01'
        textMap.tracestate = 'other=bleh,dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo;t.dm:-4'
        config.tracePropagationStyle.extract = ['tracecontext']

        const carrier = {}
        const spanContext = propagator.extract(textMap)

        propagator.inject(spanContext, carrier)

        expect(carrier.tracestate).to.include('other=bleh')
        t.end()
      })

      t.test('should propagate last datadog id', t => {
        textMap.traceparent = '01-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01'
        textMap.tracestate = 'other=bleh,dd=s:2;o:foo;t.dm:-4;p:4444eeee6666aaaa'
        config.tracePropagationStyle.extract = ['tracecontext']

        const carrier = {}
        const spanContext = propagator.extract(textMap)
        // Ensure the span context is marked as remote (i.e. not generated by the current process)
        expect(spanContext._isRemote).to.equal(true)

        propagator.inject(spanContext, carrier)

        expect(carrier.tracestate).to.include('p:4444eeee6666aaaa')
        t.end()
      })

      t.test('should fix _dd.p.dm if invalid (non-hyphenated) input is received', t => {
        textMap.traceparent = '01-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01'
        textMap.tracestate = 'other=bleh,dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo;t.dm:4'
        config.tracePropagationStyle.extract = ['tracecontext']

        const carrier = {}
        const spanContext = propagator.extract(textMap)

        propagator.inject(spanContext, carrier)

        expect(carrier['x-datadog-tags']).to.include('_dd.p.dm=-4')
        expect(spanContext._trace.tags['_dd.p.dm']).to.eql('-4')
        t.end()
      })

      t.test('should maintain hyphen prefix when a default mechanism of 0 is received', t => {
        textMap.traceparent = '01-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01'
        textMap.tracestate = 'other=bleh,dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo;t.dm:-0'
        config.tracePropagationStyle.extract = ['tracecontext']

        const carrier = {}
        const spanContext = propagator.extract(textMap)

        propagator.inject(spanContext, carrier)

        expect(carrier['x-datadog-tags']).to.include('_dd.p.dm=-0')
        expect(spanContext._trace.tags['_dd.p.dm']).to.eql('-0')
        t.end()
      })

      t.test('should log extraction', t => {
        const traceparent = textMap.traceparent = '00-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01'
        const tracestate = textMap.tracestate = 'other=bleh,dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo;t.dm:-4'

        config.tracePropagationStyle.extract = ['tracecontext']

        propagator.extract(textMap)

        expect(log.debug).to.have.been.called
        expect(log.debug.firstCall.args[0]()).to.equal([
          'Extract from carrier (tracecontext):',
          `{"traceparent":"${traceparent}","tracestate":"${tracestate}"}.`
        ].join(' '))
        t.end()
      })
      t.end()
    })

    t.test('tracePropagationBehaviorExtract', t => {
      let traceId
      let spanId

      t.beforeEach(() => {
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

      t.test('should reset span links when Trace_Propagation_Behavior_Extract is set to ignore', t => {
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
        t.end()
      })

      t.test('should set span link to extracted trace when Trace_Propagation_Behavior_Extract is set to restart', t => {
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
        t.end()
      })

      t.test('should not extract baggage when Trace_Propagation_Behavior_Extract is set to ignore', t => {
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
        t.end()
      })
      t.end()
    })
    t.end()
  })
  t.end()
})
