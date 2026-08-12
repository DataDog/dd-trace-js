'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const {
  resolveOrchestrationSpanBounds,
} = require('../../src/helpers/otel-orchestration-export')
const {
  stampOrchestrationStartTime,
} = require('../../src/helpers/otel-orchestration-store')

describe('otel orchestration span timing', () => {
  describe('stampOrchestrationStartTime', () => {
    it('stamps the first orchestration turn once', () => {
      const seeded = {
        traceId: 'abc',
        spanId: 'def',
        pendingStart: true,
      }

      const first = stampOrchestrationStartTime(seeded, 'PizzaOrderOrchestration')
      assert.ok(first.startTime)
      assert.strictEqual(first.pendingStart, undefined)

      const second = stampOrchestrationStartTime(first, 'PizzaOrderOrchestration')
      assert.strictEqual(second.startTime, first.startTime)
    })
  })

  describe('resolveOrchestrationSpanBounds', () => {
    it('spans the full instance window from first turn through completion', () => {
      const bounds = resolveOrchestrationSpanBounds({ startTime: 100 }, 350)

      assert.strictEqual(bounds.startTime, 100)
      assert.strictEqual(bounds.endTime, 350)
    })

    it('clamps start time when it would exceed the end time', () => {
      const bounds = resolveOrchestrationSpanBounds({ startTime: 400 }, 350)

      assert.strictEqual(bounds.startTime, 350)
      assert.strictEqual(bounds.endTime, 350)
    })
  })
})
