'use strict'

const constants = require('../src/constants')
const tags = require('../../../ext/tags')
const id = require('../src/id')

const SAMPLING_PRIORITY_KEY = constants.SAMPLING_PRIORITY_KEY
const ANALYTICS_KEY = constants.ANALYTICS_KEY
const ANALYTICS = tags.ANALYTICS
const ORIGIN_KEY = constants.ORIGIN_KEY
const HOSTNAME_KEY = constants.HOSTNAME_KEY

const spanId = id('0234567812345678')

describe('format', () => {
  let format
  let span
  let trace
  let spanContext
  let platform

  beforeEach(() => {
    spanContext = {
      _traceId: spanId,
      _spanId: spanId,
      _parentId: spanId,
      _tags: {},
      _metrics: {},
      _sampling: {},
      _trace: {},
      _name: 'operation'
    }

    span = {
      context: sinon.stub().returns(spanContext),
      tracer: sinon.stub().returns({
        _service: 'test'
      }),
      _startTime: 1500000000000.123456,
      _duration: 100
    }

    platform = {
      hostname: sinon.stub().returns('my_hostname')
    }

    format = proxyquire('../src/format', {
      './platform': platform
    })
  })

  describe('format', () => {
    it('should convert a span to the correct trace format', () => {
      trace = format(span)

      expect(trace.trace_id.toString()).to.equal(span.context()._traceId.toString())
      expect(trace.span_id.toString()).to.equal(span.context()._spanId.toString())
      expect(trace.parent_id.toString()).to.equal(span.context()._parentId.toString())
      expect(trace.name).to.equal(span.context()._name)
      expect(trace.resource).to.equal(span.context()._name)
      expect(trace.error).to.equal(0)
      expect(trace.start).to.equal(span._startTime * 1e6)
      expect(trace.duration).to.equal(span._duration * 1e6)
    })

    it('should always set a parent ID', () => {
      span.context()._parentId = null

      trace = format(span)

      expect(trace.trace_id.toString()).to.equal(span.context()._traceId.toString())
      expect(trace.span_id.toString()).to.equal(span.context()._spanId.toString())
      expect(trace.parent_id.toString()).to.equal('0000000000000000')
      expect(trace.name).to.equal(span.context()._name)
      expect(trace.resource).to.equal(span.context()._name)
      expect(trace.error).to.equal(0)
      expect(trace.start).to.equal(span._startTime * 1e6)
      expect(trace.duration).to.equal(span._duration * 1e6)
    })

    it('should extract Datadog specific tags', () => {
      spanContext._tags['service.name'] = 'service'
      spanContext._tags['span.type'] = 'type'
      spanContext._tags['resource.name'] = 'resource'

      trace = format(span)

      expect(trace.service).to.equal('service')
      expect(trace.type).to.equal('type')
      expect(trace.resource).to.equal('resource')
    })

    it('should discard user-defined tags with name HOSTNAME_KEY by default', () => {
      spanContext._tags[HOSTNAME_KEY] = 'some_hostname'

      trace = format(span)

      expect(trace.meta[HOSTNAME_KEY]).to.be.undefined
    })

    it('should include the real hostname of the system if reportHostname is true', () => {
      spanContext._hostname = 'my_hostname'
      trace = format(span)

      expect(trace.meta[HOSTNAME_KEY]).to.equal('my_hostname')
    })

    it('should only extract tags that are not Datadog specific to meta', () => {
      spanContext._tags['service.name'] = 'service'
      spanContext._tags['span.type'] = 'type'
      spanContext._tags['resource.name'] = 'resource'
      spanContext._tags['foo.bar'] = 'foobar'

      trace = format(span)

      expect(trace.meta['service.name']).to.be.undefined
      expect(trace.meta['span.type']).to.be.undefined
      expect(trace.meta['resource.name']).to.be.undefined
      expect(trace.meta['foo.bar']).to.equal('foobar')
    })

    it('should extract numeric tags as metrics', () => {
      spanContext._tags = { metric: 50 }

      trace = format(span)

      expect(trace.metrics).to.have.property('metric', 50)
    })

    it('should ignore metrics with invalid type', () => {
      spanContext._metrics = { metric: 'test' }

      trace = format(span)

      expect(trace.metrics).to.not.have.property('metric')
    })

    it('should ignore metrics that are not a number', () => {
      spanContext._metrics = { metric: NaN }

      trace = format(span)

      expect(trace.metrics).to.not.have.property('metric')
    })

    it('should extract errors', () => {
      const error = new Error('boom')

      spanContext._tags['error'] = error
      trace = format(span)

      expect(trace.meta['error.msg']).to.equal(error.message)
      expect(trace.meta['error.type']).to.equal(error.name)
      expect(trace.meta['error.stack']).to.equal(error.stack)
    })

    it('should extract the origin', () => {
      spanContext._trace.origin = 'synthetics'

      trace = format(span)

      expect(trace.meta[ORIGIN_KEY]).to.equal('synthetics')
    })

    it('should extract unempty objects', () => {
      spanContext._tags['root'] = {
        level1: {
          level2: {
            level3: {}
          },
          array: ['hello']
        }
      }

      trace = format(span)

      expect(trace.meta['root.level1.array']).to.equal('hello')
      expect(trace.meta['root.level1.level2']).to.be.undefined
      expect(trace.meta['root.level1.level2.level3']).to.be.undefined
    })

    it('should support nested arrays', () => {
      spanContext._tags['root'] = {
        array: ['a', ['b', ['c']]]
      }

      trace = format(span)

      expect(trace.meta['root.array']).to.equal('a,b,c')
    })

    it('should support objects in arrays', () => {
      class Foo {}

      spanContext._tags['root'] = {
        array: ['a', { 'bar': 'baz' }, new Foo()]
      }

      trace = format(span)

      expect(trace.meta['root.array']).to.equal('a,[object Object],[object Object]')
    })

    it('should add runtime tags', () => {
      spanContext._tags['service.name'] = 'test'

      trace = format(span)

      expect(trace.meta['language']).to.equal('javascript')
    })

    it('should add runtime tags only for the root service', () => {
      spanContext._tags['service.name'] = 'other'

      trace = format(span)

      expect(trace.meta).to.not.have.property('language')
    })

    describe('when there is an `error` tag ', () => {
      it('should set the error flag when error tag is true', () => {
        spanContext._tags['error'] = true

        trace = format(span)

        expect(trace.error).to.equal(1)
      })

      it('should not set the error flag when error is false', () => {
        spanContext._tags['error'] = false

        trace = format(span)

        expect(trace.error).to.equal(0)
      })

      it('should not extract error to meta', () => {
        spanContext._tags['error'] = true

        trace = format(span)

        expect(trace.meta['error']).to.be.undefined
      })
    })

    it('should set the error flag when there is an error-related tag', () => {
      spanContext._tags['error.type'] = 'Error'
      spanContext._tags['error.msg'] = 'boom'
      spanContext._tags['error.stack'] = ''

      trace = format(span)

      expect(trace.error).to.equal(1)
    })

    it('should sanitize the input', () => {
      spanContext._name = null
      spanContext._tags = {
        'foo.bar': null,
        'baz.qux': undefined
      }
      span._startTime = NaN
      span._duration = NaN

      trace = format(span)

      expect(trace.name).to.equal('null')
      expect(trace.resource).to.equal('null')
      expect(trace.meta).to.not.have.property('foo.bar')
      expect(trace.meta).to.not.have.property('baz.qux')
      expect(trace.start).to.be.a('number')
      expect(trace.duration).to.be.a('number')
    })

    it('should include the sampling priority', () => {
      spanContext._sampling.priority = 0
      trace = format(span)
      expect(trace.metrics[SAMPLING_PRIORITY_KEY]).to.equal(0)
    })

    it('should support objects without a toString implementation', () => {
      spanContext._tags['foo'] = []
      spanContext._tags['foo'].toString = null
      trace = format(span)
      expect(trace.meta['foo']).to.equal('[]')
    })

    it('should support objects with a non-function toString property', () => {
      spanContext._tags['foo'] = []
      spanContext._tags['foo'].toString = 'baz'
      trace = format(span)
      expect(trace.meta['foo']).to.equal('[]')
    })

    it('should support direct circular references', () => {
      const tag = { 'foo': 'bar' }

      tag.self = tag
      spanContext._tags['circularTag'] = tag

      trace = format(span)

      expect(trace.meta['circularTag.foo']).to.equal('bar')
      expect(trace.meta['circularTag.self']).to.equal('[Circular]')
    })

    it('should support indirect circular references', () => {
      const obj = { 'foo': 'bar' }
      const tag = { obj, 'baz': 'qux' }

      obj.self = tag

      spanContext._tags['circularTag'] = tag
      trace = format(span)

      expect(trace.meta['circularTag.baz']).to.equal('qux')
      expect(trace.meta['circularTag.obj.foo']).to.equal('bar')
      expect(trace.meta['circularTag.obj.self']).to.equal('[Circular]')
    })

    it('should support deep circular references', () => {
      const tag = {
        A: {
          B: {
            C: {
              D: {
                E: {
                  num: '6'
                },
                num: '5'
              },
              num: '4'
            },
            num: '3'
          },
          num: '2'
        },
        num: '1'
      }

      tag.A.B.C.D.E.self = tag.A.B

      spanContext._tags['circularTag'] = tag
      trace = format(span)

      expect(trace.meta['circularTag.num']).to.equal('1')
      expect(trace.meta['circularTag.A.num']).to.equal('2')
      expect(trace.meta['circularTag.A.B.num']).to.equal('3')
      expect(trace.meta['circularTag.A.B.C.num']).to.equal('4')
      expect(trace.meta['circularTag.A.B.C.D.num']).to.equal('5')
      expect(trace.meta['circularTag.A.B.C.D.E.num']).to.equal('6')
      expect(trace.meta['circularTag.A.B.C.D.E.self']).to.equal('[Circular]')
    })

    it('should support circular references in a class', () => {
      class CircularTag {
        constructor () {
          this.foo = 'bar'
          this.self = this
        }
      }

      const tag = new CircularTag()

      spanContext._tags['circularTag'] = tag
      trace = format(span)

      expect(trace.meta['circularTag.foo']).to.equal('bar')
      expect(trace.meta['circularTag.self']).to.equal('[Circular]')
    })

    it('should support re-used objects', () => {
      const obj = { foo: 'bar' }
      const tag = {
        baz: obj,
        qux: obj
      }

      spanContext._tags['circularTag'] = tag
      trace = format(span)

      expect(trace.meta['circularTag.baz.foo']).to.equal('bar')
      expect(trace.meta['circularTag.qux.foo']).to.equal('bar')
    })

    it('should support doubly-linked objects', () => {
      const tag = {
        selfA: { ghost: 'eater' },
        selfB: { space: 'invader' }
      }

      tag.selfA.self = tag.selfB
      tag.selfB.self = tag.selfA

      spanContext._tags['circularTag'] = tag
      trace = format(span)

      expect(trace.meta['circularTag.selfA.ghost']).to.equal('eater')
      expect(trace.meta['circularTag.selfA.self.self']).to.equal('[Circular]')
      expect(trace.meta['circularTag.selfA.self.space']).to.equal('invader')
      expect(trace.meta['circularTag.selfB.self.ghost']).to.equal('eater')
      expect(trace.meta['circularTag.selfB.self.self']).to.equal('[Circular]')
      expect(trace.meta['circularTag.selfB.space']).to.equal('invader')
    })

    it('should support re-used arrays', () => {
      const obj = ['bar']
      const tag = {
        baz: obj,
        qux: obj
      }

      spanContext._tags['circularTag'] = tag
      trace = format(span)

      expect(trace.meta['circularTag.baz']).to.equal('bar')
      expect(trace.meta['circularTag.qux']).to.equal('bar')
    })

    it('should support re-used arrays within arrays', () => {
      const obj = {}
      const tag = [obj, [obj]]

      spanContext._tags['circularTag'] = tag
      trace = format(span)

      expect(trace.meta['circularTag']).to.equal('[object Object],[object Object]')
    })

    it('should include the analytics sample rate', () => {
      spanContext._tags[ANALYTICS] = 0.5
      trace = format(span)
      expect(trace.metrics[ANALYTICS_KEY]).to.equal(0.5)
    })

    it('should limit the min analytics sample rate', () => {
      spanContext._tags[ANALYTICS] = -1
      trace = format(span)
      expect(trace.metrics[ANALYTICS_KEY]).to.equal(0)
    })

    it('should limit the max analytics sample rate', () => {
      spanContext._tags[ANALYTICS] = 2
      trace = format(span)
      expect(trace.metrics[ANALYTICS_KEY]).to.equal(1)
    })

    it('should accept boolean true for analytics', () => {
      spanContext._tags[ANALYTICS] = true
      trace = format(span)
      expect(trace.metrics[ANALYTICS_KEY]).to.equal(1)
    })

    it('should accept boolean false for analytics', () => {
      spanContext._tags[ANALYTICS] = false
      trace = format(span)
      expect(trace.metrics[ANALYTICS_KEY]).to.be.undefined
    })

    it('should accept strings for analytics', () => {
      spanContext._tags[ANALYTICS] = '0.5'
      trace = format(span)
      expect(trace.metrics[ANALYTICS_KEY]).to.equal(0.5)
    })
  })
})
