'use strict'

require('../../setup/tap')

const Config = require('../../../src/config')
const id = require('../../../src/id')
const SpanContext = require('../../../src/opentracing/span_context')
const TraceState = require('../../../src/opentracing/propagation/tracestate')

const { AUTO_KEEP, AUTO_REJECT, USER_KEEP } = require('../../../../../ext/priority')
const { SAMPLING_MECHANISM_MANUAL } = require('../../../src/constants')
const { expect } = require('chai')

describe('TextMapPropagator', () => {
  let TextMapPropagator
  let propagator
  let textMap
  let baggageItems
  let config

  const createContext = (params = {}) => {
    const trace = { started: [], finished: [], tags: {} }
    const spanContext = new SpanContext({
      traceId: id('123', 10),
      spanId: id('456', 10),
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
    TextMapPropagator = require('../../../src/opentracing/propagation/text_map')
    config = new Config({ tagsHeaderMaxLength: 512 })
    propagator = new TextMapPropagator(config)
    textMap = {
      'x-datadog-trace-id': '123',
      'x-datadog-parent-id': '456',
      'ot-baggage-foo': 'bar'
    }
    baggageItems = {}
  })

  describe('inject', () => {
    beforeEach(() => {
      baggageItems = {
        foo: 'bar'
      }
    })

    it('should inject the span context into the carrier', () => {
      const carrier = {}
      const spanContext = createContext()

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('x-datadog-trace-id', '123')
      expect(carrier).to.have.property('x-datadog-parent-id', '456')
      expect(carrier).to.have.property('ot-baggage-foo', 'bar')
    })

    it('should handle non-string values', () => {
      const carrier = {}
      const spanContext = createContext({
        baggageItems: {
          number: 1.23,
          bool: true,
          array: ['foo', 'bar'],
          object: {}
        }
      })

      propagator.inject(spanContext, carrier)

      expect(carrier['ot-baggage-number']).to.equal('1.23')
      expect(carrier['ot-baggage-bool']).to.equal('true')
      expect(carrier['ot-baggage-array']).to.equal('foo,bar')
      expect(carrier['ot-baggage-object']).to.equal('[object Object]')
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
            'bar': 'bar',
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
            '_ddupefoo': 'value'
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
        tracestate: TraceState.fromString('other=bleh,dd=s:2;o:foo_bar_;t.dm:-4')
      })
      // Include invalid characters to verify underscore conversion
      spanContext._trace.origin = 'foo,bar='
      spanContext._trace.tags['_dd.p.foo bar,baz='] = 'abc~!@#$%^&*()_+`-='

      config.tracePropagationStyle.inject = ['tracecontext']

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('traceparent', '00-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01')
      expect(carrier).to.have.property(
        'tracestate',
        'dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo_bar~;t.dm:4,other=bleh'
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
  })

  describe('extract', () => {
    it('should extract a span context from the carrier', () => {
      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext.toTraceId()).to.equal(carrier['x-datadog-trace-id'])
      expect(spanContext.toSpanId()).to.equal(carrier['x-datadog-parent-id'])
      expect(spanContext._baggageItems['foo']).to.equal(carrier['ot-baggage-foo'])
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

      textMap['traceparent'] = `00-${traceId}-${spanId}-01`

      const first = propagator.extract(textMap)

      expect(first._traceId.toString(16)).to.equal(traceId)
      expect(first._spanId.toString(16)).to.equal(spanId)
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
    })

    describe('with B3 propagation as a single header', () => {
      beforeEach(() => {
        config.tracePropagationStyle.extract = ['b3 single header']

        delete textMap['x-datadog-trace-id']
        delete textMap['x-datadog-parent-id']
      })

      it('should extract the header', () => {
        textMap['b3'] = '0000000000000123-0000000000000456'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.deep.equal(createContext({
          traceId: id('123', 16),
          spanId: id('456', 16)
        }))
      })

      it('should extract sampling', () => {
        textMap['b3'] = '0000000000000123-0000000000000456-1'

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
        textMap['b3'] = '0000000000000123-0000000000000456-1-0000000000000789'

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
        textMap['b3'] = '0'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._sampling.priority).to.equal(AUTO_REJECT)
      })

      it('should support sampled traces', () => {
        textMap['b3'] = '1'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._sampling.priority).to.equal(AUTO_KEEP)
      })

      it('should support the debug flag', () => {
        textMap['b3'] = 'd'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._sampling.priority).to.equal(USER_KEEP)
      })

      it('should skip extraction without the feature flag', () => {
        textMap['b3'] = '0000000000000123-0000000000000456-1-0000000000000789'

        config.tracePropagationStyle.extract = []

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.be.null
      })

      it('should support 128-bit trace IDs', () => {
        textMap['b3'] = '00000000000002340000000000000123-0000000000000456'

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
        textMap['b3'] = '00000000000000000000000000000123-0000000000000456'

        config.traceId128BitGenerationEnabled = true

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.deep.equal(createContext({
          traceId: id('00000000000000000000000000000123', 16),
          spanId: id('456', 16)
        }))
      })
    })

    describe('With traceparent propagation as single header', () => {
      beforeEach(() => {
        delete textMap['x-datadog-trace-id']
        delete textMap['x-datadog-parent-id']
      })

      it('should skip extraction without the feature flag', () => {
        textMap['traceparent'] = '00-000000000000000000000000000004d2-000000000000162e-01'
        config.tracePropagationStyle.extract = []

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        expect(spanContext).to.be.null
      })

      it('should extract the header', () => {
        textMap['traceparent'] = '00-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01'
        textMap['tracestate'] = 'other=bleh,dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo;t.dm:-4'
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
        textMap['traceparent'] = '00-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01'
        config.tracePropagationStyle.extract = ['tracecontext']
        config.traceId128BitGenerationEnabled = true

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        expect(spanContext._traceId.toString(16)).to.equal('1111aaaa2222bbbb3333cccc4444dddd')
        expect(spanContext._trace.tags).to.have.property('_dd.p.tid', '1111aaaa2222bbbb')
      })

      it('should skip extracting upper bits for 64-bit trace IDs', () => {
        textMap['traceparent'] = '00-00000000000000003333cccc4444dddd-5555eeee6666ffff-01'
        config.tracePropagationStyle.extract = ['tracecontext']
        config.traceId128BitGenerationEnabled = true

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext._traceId.toString(16)).to.equal('00000000000000003333cccc4444dddd')
        expect(spanContext._trace.tags).to.not.have.property('_dd.p.tid')
      })

      it('should propagate the version', () => {
        textMap['traceparent'] = '01-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01'
        textMap['tracestate'] = 'other=bleh,dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo;t.dm:-4'
        config.tracePropagationStyle.extract = ['tracecontext']

        const carrier = {}
        const spanContext = propagator.extract(textMap)

        propagator.inject(spanContext, carrier)

        expect(carrier.traceparent).to.match(/^01/)
        expect(carrier['x-datadog-tags']).to.include('_dd.p.dm=-4')
        expect(spanContext._trace.tags['_dd.p.dm']).to.eql('-4')
      })

      it('should fix _dd.p.dm if invalid (non-hyphenated) input is received', () => {
        textMap['traceparent'] = '01-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01'
        textMap['tracestate'] = 'other=bleh,dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo;t.dm:4'
        config.tracePropagationStyle.extract = ['tracecontext']

        const carrier = {}
        const spanContext = propagator.extract(textMap)

        propagator.inject(spanContext, carrier)

        expect(carrier['x-datadog-tags']).to.include('_dd.p.dm=-4')
        expect(spanContext._trace.tags['_dd.p.dm']).to.eql('-4')
      })

      it('should maintain hyphen prefix when a default mechanism of 0 is received', () => {
        textMap['traceparent'] = '01-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01'
        textMap['tracestate'] = 'other=bleh,dd=t.foo_bar_baz_:abc_!@#$%^&*()_+`-~;s:2;o:foo;t.dm:-0'
        config.tracePropagationStyle.extract = ['tracecontext']

        const carrier = {}
        const spanContext = propagator.extract(textMap)

        propagator.inject(spanContext, carrier)

        expect(carrier['x-datadog-tags']).to.include('_dd.p.dm=-0')
        expect(spanContext._trace.tags['_dd.p.dm']).to.eql('-0')
      })
    })
  })
})
