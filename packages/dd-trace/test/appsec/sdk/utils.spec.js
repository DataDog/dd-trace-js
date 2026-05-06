'use strict'

const assert = require('node:assert/strict')
const { getRootSpan } = require('../../../src/appsec/sdk/utils')
const DatadogTracer = require('../../../src/tracer')
const { getConfigFresh } = require('../../helpers/config')
const { storage } = require('../../../../datadog-core')
const id = require('../../../src/id')

describe('Appsec SDK utils', () => {
  let tracer

  before(() => {
    tracer = new DatadogTracer(getConfigFresh({
      enabled: true,
    }))
  })

  describe('getRootSpan', () => {
    it('should return root span if there are no childs', () => {
      const parent = tracer.startSpan('parent')
      storage('legacy').run({ span: parent }, () => {
        const root = getRootSpan()

        assert.strictEqual(root, parent)
      })
    })

    it('should return root span of single child', () => {
      const childOf = tracer.startSpan('parent')
      const child1 = tracer.startSpan('child1', { childOf })
      storage('legacy').run({ span: child1 }, () => {
        const root = getRootSpan()

        assert.strictEqual(root, childOf)
      })
    })

    it('should return root span of single child from unknown parent', () => {
      const childOf = tracer.startSpan('parent')
      childOf.context()._parentId = id()

      const child1 = tracer.startSpan('child1', { childOf })
      storage('legacy').run({ span: child1 }, () => {
        const root = getRootSpan()

        assert.strictEqual(root, childOf)
      })
    })

    it('should return root span of multiple child', () => {
      const childOf = tracer.startSpan('parent')

      const child11 = tracer.startSpan('child1.1', { childOf })
      tracer.startSpan('child1.1.2', { childOf: child11 })

      const child12 = tracer.startSpan('child1.2', { childOf })
      storage('legacy').run({ span: child12 }, () => {
        const root = getRootSpan()

        assert.strictEqual(root, childOf)
      })
    })

    it('should return root span of single child discarding inferred spans', () => {
      const childOf = tracer.startSpan('parent')
      childOf.setTag('_inferred_span', {})

      const child1 = tracer.startSpan('child1', { childOf })
      storage('legacy').run({ span: child1 }, () => {
        const root = getRootSpan()

        assert.strictEqual(root, child1)
      })
    })

    it('should return root span of an inferred span', () => {
      const childOf = tracer.startSpan('parent')

      const child1 = tracer.startSpan('child1', { childOf })
      storage('legacy').run({ span: child1 }, () => {
        child1.setTag('_inferred_span', {})

        const root = getRootSpan()

        assert.strictEqual(root, childOf)
      })
    })

    it('should return root span of an inferred span with inferred parent', () => {
      const childOf = tracer.startSpan('parent')
      childOf.setTag('_inferred_span', {})

      const child1 = tracer.startSpan('child1', { childOf })
      storage('legacy').run({ span: child1 }, () => {
        child1.setTag('_inferred_span', {})

        const root = getRootSpan()

        assert.strictEqual(root, child1)
      })
    })

    it('should return root span discarding inferred spans (mutiple childs)', () => {
      const childOf = tracer.startSpan('parent')
      childOf.setTag('_inferred_span', {})

      tracer.startSpan('child1.1', { childOf })
      const child12 = tracer.startSpan('child1.2', { childOf })
      const child121 = tracer.startSpan('child1.2.1', { childOf: child12 })
      storage('legacy').run({ span: child121 }, () => {
        const root = getRootSpan()
        assert.strictEqual(root, child12)
      })
    })

    it('should return root span discarding inferred spans if it is direct parent (mutiple childs)', () => {
      const childOf = tracer.startSpan('parent')

      tracer.startSpan('child1.1', { childOf })
      const child12 = tracer.startSpan('child1.2', { childOf })
      child12.setTag('_inferred_span', {})

      const child121 = tracer.startSpan('child1.2.1', { childOf: child12 })
      storage('legacy').run({ span: child121 }, () => {
        const root = getRootSpan()

        assert.strictEqual(root, childOf)
      })
    })

    it('should return root span discarding multiple inferred spans', () => {
      const childOf = tracer.startSpan('parent')

      tracer.startSpan('child1.1', { childOf })
      const child12 = tracer.startSpan('child1.2', { childOf })
      child12.setTag('_inferred_span', {})

      const child121 = tracer.startSpan('child1.2.1', { childOf: child12 })
      child121.setTag('_inferred_span', {})

      const child1211 = tracer.startSpan('child1.2.1.1', { childOf: child121 })
      storage('legacy').run({ span: child1211 }, () => {
        const root = getRootSpan()

        assert.strictEqual(root, childOf)
      })
    })

    it('should return itself as root span if all are inferred spans', () => {
      const childOf = tracer.startSpan('parent')
      childOf.setTag('_inferred_span', {})

      tracer.startSpan('child1.1', { childOf })
      const child12 = tracer.startSpan('child1.2', { childOf })
      child12.setTag('_inferred_span', {})

      const child121 = tracer.startSpan('child1.2.1', { childOf: child12 })
      child121.setTag('_inferred_span', {})

      const child1211 = tracer.startSpan('child1.2.1.1', { childOf: child121 })
      storage('legacy').run({ span: child1211 }, () => {
        const root = getRootSpan()

        assert.strictEqual(root, child1211)
      })
    })
  })
})
