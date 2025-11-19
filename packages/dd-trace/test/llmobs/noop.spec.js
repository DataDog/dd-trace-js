'use strict'

const { expect } = require('chai')
const { describe, it, before } = require('mocha')

const assert = require('node:assert')

describe.only('noop', () => {
  let tracer
  let llmobs

  before(() => {
    tracer = new (require('../../../dd-trace/src/noop/proxy'))()
    llmobs = tracer.llmobs
  })

  it('using "enable" should not throw', () => {
    llmobs.enable()
  })

  it('using "disable" should not throw', () => {
    llmobs.disable()
  })

  it('using "annotate" should not throw', () => {
    llmobs.annotate()
  })

  it('using "exportSpan" should not throw', () => {
    llmobs.exportSpan()
  })

  it('using "submitEvaluation" should not throw', () => {
    llmobs.submitEvaluation()
  })

  it('using "flush" should not throw', () => {
    llmobs.flush()
  })

  it('using "registerProcessor" should not throw', () => {
    llmobs.registerProcessor(() => {})
  })

  it('using "deregisterProcessor" should not throw', () => {
    llmobs.deregisterProcessor()
  })

  it('using "annotationContext" should not throw', () => {
    const result = llmobs.annotationContext({}, () => {
      return 5
    })

    assert.equal(result, 5)
  })

  describe('trace', () => {
    it('should not throw with just a span', () => {
      const res = llmobs.trace({}, (span) => {
        expect(() => span.setTag('foo', 'bar')).does.not.throw
        return 1
      })

      expect(res).to.equal(1)
    })

    it('should not throw with a span and a callback', async () => {
      const prom = llmobs.trace({}, (span, cb) => {
        expect(() => span.setTag('foo', 'bar')).does.not.throw
        expect(() => cb()).does.not.throw
        return Promise.resolve(5)
      })

      expect(await prom).to.equal(5)
    })
  })

  describe('wrap', () => {
    it('should not throw with just a span', () => {
      function fn () {
        return 1
      }

      const wrapped = llmobs.wrap({}, fn)
      expect(wrapped()).to.equal(1)
    })

    it('should not throw with a span and a callback', async () => {
      function fn () {
        return Promise.resolve(5)
      }
      const wrapped = llmobs.wrap({}, fn)
      expect(await wrapped()).to.equal(5)
    })
  })
})
