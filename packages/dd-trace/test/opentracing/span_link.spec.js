'use strict'

require('../setup/tap')

describe('SpanLink', () => {
  let SpanLink
  let SpanContext
  let TraceState
  let id
  let traceId
  let spanId
  let handleSpanLinks
  let traceId2
  let spanId2

  beforeEach(() => {
    SpanLink = require('../../src/opentracing/span_link')
    SpanContext = require('../../src/opentracing/span_context')
    TraceState = require('../../src/opentracing/propagation/tracestate')
    const module = require('../../src/span_link_processor')
    handleSpanLinks = module.handleSpanLinks
    id = require('../../src/id')

    traceId = id('123', 10)
    spanId = id('456', 10)
    traceId2 = id('789', 10)
    spanId2 = id('101', 10)
  })

  it('creates a span link', () => {
    const ts = TraceState.fromString('dd=s:-1;o:foo;t.dm:-4;t.usr.id:bar')

    const spanContext2 = new SpanContext({
      traceId,
      spanId: spanId2,
      tracestate: ts,
      trace: {
        started: [],
        finished: [],
        origin: 'synthetics',
        tags: {
          '_dd.p.tid': '789'
        }
      }
    })

    spanContext2._flags = 0
    const spanContext = new SpanContext({
      traceId: traceId,
      spanId: spanId
    })

    const links = []
    handleSpanLinks(links, spanContext2, { foo: 'bar' }, spanContext)
    const spanLink = JSON.parse(links[0])
    expect(spanLink).to.have.property('trace_id', '789' + traceId.toString())
    expect(spanLink).to.have.property('span_id', spanId2.toString())
    expect(spanLink).to.have.property('flags', 0)
    expect(spanLink).to.have.property('tracestate', ts.toString())
    expect(spanLink.attributes).to.deep.equal({ foo: 'bar' })
    expect(spanLink).to.have.property('trace_id_high', '789')
  })

  it('will not use the span context if the link object specifies a different trace', () => {
    const spanContext2 = new SpanContext({ traceId, spanId })
    const spanContext = new SpanContext({
      traceId: id(), // not used
      spanId: id() // not used
    })

    const links = []
    handleSpanLinks(links, spanContext2, {}, spanContext)
    const spanLink = JSON.parse(links[0])
    expect(spanLink).to.have.property('trace_id', traceId.toString())
    expect(spanLink).to.have.property('span_id', spanId.toString())
    expect(spanLink).to.not.have.property('flags')
    expect(spanLink).to.not.have.property('tracestate')
    expect(spanLink).to.not.have.property('trace_id_high')
    expect(spanLink).to.not.have.property('attributes')
  })

  describe('sanitizing', () => {
    it('sanitizes attributes', () => {
      const attributes = {
        foo: 'bar',
        baz: 'qux'
      }

      const spanContext2 = new SpanContext({ traceId, spanId })
      const spanContext = new SpanContext({
        traceId: id(), // not used
        spanId: id() // not used
      })

      const links = []
      handleSpanLinks(links, spanContext2, attributes, spanContext)
      const spanLink = JSON.parse(links[0])
      expect(spanLink.attributes).to.deep.equal(attributes)
    })

    it('sanitizes nested attributes', () => {
      const attributes = {
        foo: true,
        bar: 'hi',
        baz: 1,
        qux: [1, 2, 3]
      }

      const spanContext2 = new SpanContext({ traceId, spanId })
      const spanContext = new SpanContext({
        traceId: id(), // not used
        spanId: id() // not used
      })

      const links = []
      handleSpanLinks(links, spanContext2, attributes, spanContext)
      const spanLink = JSON.parse(links[0])
      console.log(44, spanLink)
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

  describe('matches()', () => {
    it('matches a span link with a correct context', () => {
      const spanLink = new SpanLink({ traceId, spanId })
      expect(spanLink.matches({ traceId, spanId })).to.equal(true)
    })

    it('does not match a span link with an incorrect context', () => {
      const spanLink = new SpanLink({ traceId, spanId })
      expect(spanLink.matches({ traceId: id(), spanId })).to.equal(false)
    })
  })
})
