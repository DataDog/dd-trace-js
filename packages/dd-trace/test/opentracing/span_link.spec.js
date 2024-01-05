'use strict'

require('../setup/tap')

describe('SpanLink', () => {
  let SpanLink
  let SpanContext
  let TraceState
  let id

  let traceId
  let spanId

  beforeEach(() => {
    SpanLink = require('../../src/opentracing/span_link')
    SpanContext = require('../../src/opentracing/span_context')
    TraceState = require('../../src/opentracing/propagation/tracestate')
    id = require('../../src/id')

    traceId = id('123', 10)
    spanId = id('456', 10)
  })

  it('creates a span link from raw information', () => {
    const ts = TraceState.fromString('dd=s:-1;o:foo;t.dm:-4;t.usr.id:bar')
    const props = {
      traceId,
      spanId,
      attributes: { foo: 'bar' },
      flags: 1,
      tracestate: ts,
      traceIdHigh: '789',
      droppedAttributesCount: 1
    }

    const spanLink = new SpanLink(props)
    expect(spanLink).to.have.property('traceId', traceId)
    expect(spanLink).to.have.property('spanId', spanId)
    expect(spanLink).to.have.property('flags', 1)
    expect(spanLink).to.have.property('tracestate', ts)
    expect(spanLink).to.have.property('traceIdHigh', '789')
    expect(spanLink.attributes).to.deep.equal({ foo: 'bar' })
  })

  it('creates a span link from a link object', () => {
    const ts = TraceState.fromString('dd=s:-1;o:foo;t.dm:-4;t.usr.id:bar')
    const link = {
      traceId,
      spanId,
      tracestate: ts,
      attributes: {
        foo: 'bar'
      },
      flags: 0
    }

    const spanLink = SpanLink.from(link)
    expect(spanLink).to.have.property('traceId', traceId)
    expect(spanLink).to.have.property('spanId', spanId)
    expect(spanLink).to.have.property('flags', 0)
    expect(spanLink).to.have.property('tracestate', ts)
    expect(spanLink).to.have.property('traceIdHigh', undefined)
    expect(spanLink.attributes).to.deep.equal({ foo: 'bar' })
  })

  it('uses the span context to default to parent span and current trace', () => {
    const ts = TraceState.fromString('dd=s:-1;o:foo;t.dm:-4;t.usr.id:bar')
    const spanContext = new SpanContext({
      traceId,
      spanId: id(), // not used
      parentId: spanId,
      tracestate: ts,
      trace: {
        origin: 'synthetics',
        tags: {
          '_dd.p.tid': '789'
        }
      }
    })

    const spanLink = SpanLink.from({}, spanContext)
    expect(spanLink).to.have.property('traceId', traceId)
    expect(spanLink).to.have.property('spanId', spanId)
    expect(spanLink).to.have.property('flags', 0)
    expect(spanLink).to.have.property('tracestate', ts)
    expect(spanLink).to.have.property('traceIdHigh', '789')
    expect(spanLink.attributes).to.deep.equal({})
  })

  it('will not use the span context if the link object specifies a different trace', () => {
    const link = { traceId, spanId }
    const spanContext = new SpanContext({
      traceId: id(), // not used
      spanId: id() // not used
    })

    const spanLink = SpanLink.from(link, spanContext)
    expect(spanLink).to.have.property('traceId', traceId)
    expect(spanLink).to.have.property('spanId', spanId)
    expect(spanLink).to.have.property('flags', undefined)
    expect(spanLink).to.have.property('tracestate', undefined)
    expect(spanLink).to.have.property('traceIdHigh', undefined)
    expect(spanLink.attributes).to.deep.equal({})
  })

  describe('sanitizing', () => {
    it('sanitizes attributes', () => {
      const attributes = {
        foo: 'bar',
        baz: 'qux'
      }

      const spanLink = new SpanLink({ traceId, spanId, attributes })
      expect(spanLink.attributes).to.deep.equal(attributes)
    })

    it('sanitizes nested attributes', () => {
      const attributes = {
        foo: true,
        bar: 'hi',
        baz: 1,
        qux: [1, 2, 3]
      }

      const spanLink = new SpanLink({ traceId, spanId, attributes })
      expect(spanLink.attributes).to.deep.equal({
        foo: true,
        bar: 'hi',
        baz: 1,
        'qux.0': 1,
        'qux.1': 2,
        'qux.2': 3
      })
    })

    it('sanitizes invalid attributes', () => {
      const attributes = {
        foo: () => {},
        bar: Symbol('bar'),
        baz: 'valid'
      }

      const spanLink = new SpanLink({ traceId, spanId, attributes })
      expect(spanLink.attributes).to.deep.equal({
        baz: 'valid'
      })
      expect(spanLink).to.have.property('_droppedAttributesCount', 2)
    })
  })

  describe('toString()', () => {
    it('stringifies a simple span link', () => {
      const spanLink = new SpanLink({ traceId, spanId })
      const encoded = `{"trace_id":"${traceId.toString()}","span_id":"${spanId.toString()}"}`

      expect(spanLink.toString()).to.equal(encoded)
      expect(spanLink.length).to.equal(Buffer.byteLength(encoded))
    })

    it('stringifies a complex span link', () => {
      const ts = TraceState.fromString('dd=s:-1;o:foo;t.dm:-4;t.usr.id:bar')
      const spanLink = new SpanLink({
        traceId,
        spanId,
        tracestate: ts,
        attributes: {
          foo: 'bar'
        },
        flags: 0
      })

      const encoded =
        `{"trace_id":"${traceId.toString()}","span_id":"${spanId.toString()}",` +
        `"tracestate":"${ts.toString()}","flags":0,"attributes":{"foo":"bar"}}`

      expect(spanLink.toString()).to.equal(encoded)
      expect(spanLink.length).to.equal(Buffer.byteLength(encoded))
    })

    it('stringifies correctly when a span link is updated after initialization', () => {
      const spanLink = new SpanLink({ traceId, spanId })
      spanLink.addAttribute('foo', 'bar')

      const encoded = `{"trace_id":"${traceId.toString()}","span_id":"${spanId.toString()}","attributes":{"foo":"bar"}}`

      expect(spanLink.toString()).to.equal(encoded)
      expect(spanLink.length).to.equal(Buffer.byteLength(encoded))
    })

    it('stringifies droppedAttributesCount properly', () => {
      const spanLink = new SpanLink({ traceId, spanId })
      spanLink.addAttribute('foo', 'bar')
      spanLink.addAttribute('baz', {}) // bad

      const encoded =
      `{"trace_id":"${traceId.toString()}","span_id":"${spanId.toString()}",` +
      `"attributes":{"foo":"bar"},"dropped_attributes_count":"1"}`

      expect(spanLink.toString()).to.equal(encoded)
      expect(spanLink.length).to.equal(Buffer.byteLength(encoded))
    })
  })

  describe('addAttribute()', () => {
    it('allows attributes to be added', () => {
      const spanLink = new SpanLink({ traceId, spanId })
      spanLink.addAttribute('foo', 'bar')

      expect(spanLink.attributes).to.deep.equal({ foo: 'bar' })
    })
  })

  describe('flushAttributes()', () => {
    it('flushes attributes correctly', () => {
      const spanLink = new SpanLink({ traceId, spanId })
      spanLink.addAttribute('foo', 'bar')
      spanLink.flushAttributes()

      const encoded =
      `{"trace_id":"${traceId.toString()}","span_id":"${spanId.toString()}","dropped_attributes_count":"1"}`

      expect(spanLink.attributes).to.deep.equal({})
      expect(spanLink).to.have.property('_droppedAttributesCount', 1)
      expect(spanLink.toString()).to.equal(encoded)
      expect(spanLink.length).to.equal(Buffer.byteLength(encoded))
    })
  })
})
