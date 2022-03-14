'use strict'

const { expect } = require('chai')
const opentracing = require('opentracing')
const os = require('os')
const agent = require('../plugins/agent')
const Reference = opentracing.Reference

describe('Tracer', () => {
  let tracer
  let fields

  beforeEach(() => {
    return agent.load()
  })

  beforeEach(() => {
    fields = {}
    tracer = require('../../../..')
  })

  describe('startSpan', () => {
    it('should start a span', () => {
      fields.tags = { foo: 'bar' }
      fields.startTime = 1234567890000000000

      const testSpan = tracer.startSpan('name', fields)
      const internalSpan = testSpan._span

      expect(internalSpan).to.deep.include({
        name: 'name',
        service: 'test',
        meta: {
          foo: 'bar'
        },
        start: fields.startTime
      })
    })

    it('should start a span that is the child of a span', () => {
      const parent = tracer.startSpan('parent')

      fields.references = [
        new Reference(opentracing.REFERENCE_CHILD_OF, parent.context())
      ]

      const child = tracer.startSpan('name', fields)

      expect(parent.context().toTraceId()).to.equal(child.context().toTraceId())
      expect(parent.context().toSpanId()).to.equal(child.context()._parentId.toString())
    })

    it('should start a span that follows from a span', () => {
      const parent = tracer.startSpan('parent')

      fields.references = [
        new Reference(opentracing.REFERENCE_FOLLOWS_FROM, parent.context())
      ]

      const child = tracer.startSpan('name', fields)

      expect(parent.context().toTraceId()).to.equal(child.context().toTraceId())
      expect(parent.context().toSpanId()).to.equal(child.context()._parentId.toString())
    })

    it('should start a span with the system hostname if reportHostname is enabled', done => {
      tracer.init({
        reportHostname: true
      })

      agent.use(traces => {
        expect(traces[0][0].meta).to.have.property('_dd.hostname', os.hostname())
      }).then(done, done)

      const testSpan = tracer.startSpan('name', fields)

      testSpan.finish()
    })

    it('should ignore additional follow references', () => {
      const parent = tracer.startSpan('parent')

      fields.references = [
        new Reference(opentracing.REFERENCE_FOLLOWS_FROM, parent.context()),
        new Reference(opentracing.REFERENCE_FOLLOWS_FROM, tracer.startSpan('sibling').context())
      ]

      const child = tracer.startSpan('name', fields)

      expect(parent.context().toTraceId()).to.equal(child.context().toTraceId())
      expect(parent.context().toSpanId()).to.equal(child.context()._parentId.toString())
    })

    it('should ignore unknown references', () => {
      const parent = tracer.startSpan('parent')

      fields.references = [
        new Reference('test', parent.context())
      ]

      const child = tracer.startSpan('name', fields)

      expect(child.context()._parentId.toString()).to.equal('0')
    })

    it('should ignore references that are not references', () => {
      fields.references = [{}]

      const child = tracer.startSpan('name', fields)

      expect(child.context()._parentId.toString()).to.equal('0')
    })

    it('should ignore references to objects other than span contexts', () => {
      fields.references = [
        new Reference(opentracing.REFERENCE_CHILD_OF, {})
      ]

      const child = tracer.startSpan('name', fields)

      expect(child.context()._parentId.toString()).to.equal('0')
    })

    it('should merge default tracer tags with span tags', done => {
      tracer.init({
        tags: {
          'foo': 'tracer',
          'bar': 'tracer'
        }
      })

      fields.tags = {
        'bar': 'span',
        'baz': 'span'
      }

      tracer.startSpan('name', fields)

      agent.use(traces => {
        expect(traces[0][0].meta).to.have.property('foo', 'tracer')
        expect(traces[0][0].meta).to.have.property('bar', 'span')
        expect(traces[0][0].meta).to.have.property('baz', 'span')
      }).then(done, done)

      const testSpan = tracer.startSpan('name', fields)

      testSpan.finish()
    })
  })
})
