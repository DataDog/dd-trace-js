'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const {
  createOrchestrationMetaFromHttpParent,
  resolveOrchestrationSpanBounds,
} = require('../../src/helpers/otel-orchestration-export')
const {
  stampOrchestrationStartTime,
} = require('../../src/helpers/otel-orchestration-store')

describe('otel orchestration span timing', () => {
  describe('createOrchestrationMetaFromHttpParent', () => {
    it('anchors start time to startNew instead of deferring it', () => {
      const meta = createOrchestrationMetaFromHttpParent('inst', {
        traceId: '00000000000000000000000000000001',
        spanId: '0000000000000002',
      }, 'PizzaOrderOrchestration', 150)

      assert.equal(meta.startTime, 150)
      assert.equal(meta.pendingStart, undefined)
    })
  })

  describe('stampOrchestrationStartTime', () => {
    it('preserves an existing start time', () => {
      const seeded = {
        traceId: 'abc',
        spanId: 'def',
        startTime: 150,
      }

      const stamped = stampOrchestrationStartTime(seeded, 'PizzaOrderOrchestration')
      assert.strictEqual(stamped.startTime, 150)
    })

    it('stamps only when start time is missing', () => {
      const seeded = {
        traceId: 'abc',
        spanId: 'def',
      }

      const first = stampOrchestrationStartTime(seeded, 'PizzaOrderOrchestration')
      assert.ok(first.startTime)

      const second = stampOrchestrationStartTime(first, 'PizzaOrderOrchestration')
      assert.strictEqual(second.startTime, first.startTime)
    })
  })

  describe('resolveOrchestrationSpanBounds', () => {
    it('spans the full instance window from startNew through completion', () => {
      const bounds = resolveOrchestrationSpanBounds({ startTime: 100 }, 350)

      assert.strictEqual(bounds.startTime, 100)
      assert.strictEqual(bounds.endTime, 350)
    })

    it('pulls the start time earlier when activities ran first', () => {
      const bounds = resolveOrchestrationSpanBounds({
        startTime: 250,
        earliestChildStartTime: 180,
      }, 350)

      assert.strictEqual(bounds.startTime, 180)
      assert.strictEqual(bounds.endTime, 350)
    })

    it('clamps start time when it would exceed the end time', () => {
      const bounds = resolveOrchestrationSpanBounds({ startTime: 400 }, 350)

      assert.strictEqual(bounds.startTime, 350)
      assert.strictEqual(bounds.endTime, 350)
    })
  })
})
