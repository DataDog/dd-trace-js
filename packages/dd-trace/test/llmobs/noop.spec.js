'use strict'

const assert = require('node:assert/strict')

const { before, describe, it } = require('mocha')

const LLMObsSDK = require('../../../dd-trace/src/llmobs/sdk')

/**
 * Get the methods of a class
 * @param {object} clsProto - The prototype of the class
 * @param {object} [options] - The options
 * @param {string[]} options.ignore - The methods to ignore
 * @returns {string[]} The methods of the class
 */
function getClassMethods (clsProto, options) {
  const ignoreList = new Set(['constructor', ...(options?.ignore ?? [])])
  return Object.getOwnPropertyNames(clsProto)
    .filter(member => {
      if (member.startsWith('_') || ignoreList.has(member)) {
        return false
      }

      const descriptor = Object.getOwnPropertyDescriptor(clsProto, member)
      return descriptor && typeof descriptor.value === 'function'
    })
}

describe('noop', () => {
  let tracer
  let llmobs

  before(() => {
    tracer = new (require('../../../dd-trace/src/noop/proxy'))()
    llmobs = tracer.llmobs
  })

  it('has all of the methods that the actual LLMObs SDK does', () => {
    assert.deepStrictEqual(
      getClassMethods(LLMObsSDK.prototype).sort(),
      // the actual LLMObs SDK inherits the "decorate" method from the NoopLLMObs SDK
      // so we need to ignore it from the noop LLMObs SDK when comparing
      getClassMethods(Object.getPrototypeOf(llmobs), { ignore: ['decorate'] }).sort()
    )
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
        // Should not throw
        span.setTag('foo', 'bar')
        return 1
      })

      assert.strictEqual(res, 1)
    })

    it('should not throw with a span and a callback', async () => {
      const prom = llmobs.trace({}, (span, cb) => {
        // Should not throw
        span.setTag('foo', 'bar')
        cb()
        return Promise.resolve(5)
      })

      assert.strictEqual(await prom, 5)
    })
  })

  describe('wrap', () => {
    it('should not throw with just a span', () => {
      function fn () {
        return 1
      }

      const wrapped = llmobs.wrap({}, fn)
      assert.strictEqual(wrapped(), 1)
    })

    it('should not throw with a span and a callback', async () => {
      function fn () {
        return Promise.resolve(5)
      }
      const wrapped = llmobs.wrap({}, fn)
      assert.strictEqual(await wrapped(), 5)
    })
  })
})
