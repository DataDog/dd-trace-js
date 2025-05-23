'use strict'

const { assert } = require('chai')

const { getRootSpan } = require('../../../src/appsec/sdk/utils')
const DatadogTracer = require('../../../src/tracer')
const Config = require('../../../src/config')
const id = require('../../../src/id')

describe('Appsec SDK utils', () => {
  let tracer

  before(() => {
    tracer = new DatadogTracer(new Config({
      enabled: true
    }))
  })

  describe('getRootSpan', () => {
    it('should return root span if there are no childs', () => {
      tracer.trace('parent', { }, parent => {
        const root = getRootSpan(tracer)

        assert.equal(root, parent)
      })
    })

    it('should return root span of single child', () => {
      const childOf = tracer.startSpan('parent')

      tracer.trace('child1', { childOf }, child1 => {
        const root = getRootSpan(tracer)

        assert.equal(root, childOf)
      })
    })

    it('should return root span of single child from unknown parent', () => {
      const childOf = tracer.startSpan('parent')
      childOf.context()._parentId = id()

      tracer.trace('child1', { childOf }, child1 => {
        const root = getRootSpan(tracer)

        assert.equal(root, childOf)
      })
    })

    it('should return root span of multiple child', () => {
      const childOf = tracer.startSpan('parent')

      tracer.trace('child1.1', { childOf }, child11 => {
        tracer.trace('child1.1.2', { childOf: child11 }, child112 => {})
      })
      tracer.trace('child1.2', { childOf }, child12 => {
        const root = getRootSpan(tracer)

        assert.equal(root, childOf)
      })
    })

    it('should return root span of single child discarding inferred spans', () => {
      const childOf = tracer.startSpan('parent')
      childOf.setTag('_inferred_span', {})

      tracer.trace('child1', { childOf }, child1 => {
        const root = getRootSpan(tracer)

        assert.equal(root, child1)
      })
    })

    it('should return root span of an inferred span', () => {
      const childOf = tracer.startSpan('parent')

      tracer.trace('child1', { childOf }, child1 => {
        child1.setTag('_inferred_span', {})

        const root = getRootSpan(tracer)

        assert.equal(root, childOf)
      })
    })

    it('should return root span of an inferred span with inferred parent', () => {
      const childOf = tracer.startSpan('parent')
      childOf.setTag('_inferred_span', {})

      tracer.trace('child1', { childOf }, child1 => {
        child1.setTag('_inferred_span', {})

        const root = getRootSpan(tracer)

        assert.equal(root, child1)
      })
    })

    it('should return root span discarding inferred spans (mutiple childs)', () => {
      const childOf = tracer.startSpan('parent')
      childOf.setTag('_inferred_span', {})

      tracer.trace('child1.1', { childOf }, child11 => {})
      tracer.trace('child1.2', { childOf }, child12 => {
        tracer.trace('child1.2.1', { childOf: child12 }, child121 => {
          const root = getRootSpan(tracer)

          assert.equal(root, child12)
        })
      })
    })

    it('should return root span discarding inferred spans if it is direct parent (mutiple childs)', () => {
      const childOf = tracer.startSpan('parent')

      tracer.trace('child1.1', { childOf }, child11 => {})
      tracer.trace('child1.2', { childOf }, child12 => {
        child12.setTag('_inferred_span', {})

        tracer.trace('child1.2.1', { childOf: child12 }, child121 => {
          const root = getRootSpan(tracer)

          assert.equal(root, childOf)
        })
      })
    })

    it('should return root span discarding multiple inferred spans', () => {
      const childOf = tracer.startSpan('parent')

      tracer.trace('child1.1', { childOf }, child11 => {})
      tracer.trace('child1.2', { childOf }, child12 => {
        child12.setTag('_inferred_span', {})

        tracer.trace('child1.2.1', { childOf: child12 }, child121 => {
          child121.setTag('_inferred_span', {})

          tracer.trace('child1.2.1.1', { childOf: child121 }, child1211 => {
            const root = getRootSpan(tracer)

            assert.equal(root, childOf)
          })
        })
      })
    })

    it('should return itself as root span if all are inferred spans', () => {
      const childOf = tracer.startSpan('parent')
      childOf.setTag('_inferred_span', {})

      tracer.trace('child1.1', { childOf }, child11 => {})
      tracer.trace('child1.2', { childOf }, child12 => {
        child12.setTag('_inferred_span', {})

        tracer.trace('child1.2.1', { childOf: child12 }, child121 => {
          child121.setTag('_inferred_span', {})

          tracer.trace('child1.2.1.1', { childOf: child121 }, child1211 => {
            const root = getRootSpan(tracer)

            assert.equal(root, child1211)
          })
        })
      })
    })
  })
})
