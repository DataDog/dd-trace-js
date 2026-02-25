'use strict'

const assert = require('node:assert/strict')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')
require('../../../setup/mocha')

const proxyquire = require('proxyquire')
const { timeBudgetSym } = require('../../../../src/debugger/devtools_client/snapshot/symbols')
const session = require('./stub-session')

describe('debugger -> devtools client -> snapshot collector deadline', function () {
  let collectObjectProperties
  let clock

  beforeEach(async function () {
    clock = sinon.useFakeTimers()

    // Stub the collector with the stubbed session
    const collectorWithStub = proxyquire('../../../../src/debugger/devtools_client/snapshot/collector', {
      '../session': session,
    })
    collectObjectProperties = collectorWithStub.collectObjectProperties

    await session.post('Debugger.enable')
  })

  afterEach(async function () {
    session.removeAllListeners('Debugger.scriptParsed')
    session.removeAllListeners('Debugger.paused')
    await session.post('Debugger.disable')
    clock.restore()
  })

  it('should not mark properties with timeout when deadline is not exceeded', async function () {
    const ctx = {
      deadlineReached: false,
      captureErrors: [],
    }

    const opts = {
      maxReferenceDepth: 3,
      maxCollectionSize: 100,
      maxFieldCount: 100,
      deadlineNs: 100_000_000n, // 100ms
      ctx,
    }

    const obj = { a: 1, b: 2, c: 3 }

    const objectId = await getObjectIdForObject(obj)
    const properties = await collectObjectProperties(objectId, opts, 0)

    // Verify no properties are marked with timeout symbol
    for (const prop of properties) {
      assert.strictEqual(prop.value?.[timeBudgetSym], undefined)
    }

    // Verify deadline was not reached
    assert.strictEqual(ctx.deadlineReached, false)
  })

  it('should mark properties with timeout when deadline is exceeded', async function () {
    // Override the hrtime stub to advance time on each call
    // This simulates time passing during collection
    sinon.restore()
    clock = sinon.useFakeTimers()
    sinon.stub(process.hrtime, 'bigint').callsFake(() => {
      const time = BigInt(clock.now) * 1_000_000n
      clock.tick(50) // Advance by 50ms after each call
      return time
    })

    const ctx = {
      deadlineReached: false,
      captureErrors: [],
    }

    const opts = {
      maxReferenceDepth: 5, // Deep enough to require multiple calls
      maxCollectionSize: 100,
      maxFieldCount: 100,
      deadlineNs: 10_000_000n, // 10ms (very tight deadline)
      ctx,
    }

    // Create a nested object structure that will take time to collect
    const nestedObj = {
      level1: {
        level2: {
          level3: {
            level4: {
              level5: { a: 1, b: 2, c: 3 },
            },
          },
        },
      },
    }

    const objectId = await getObjectIdForObject(nestedObj)
    await collectObjectProperties(objectId, opts, 0)

    // Verify deadline was reached during collection
    assert.strictEqual(ctx.deadlineReached, true)
  })

  it('should cache deadline reached state in ctx', async function () {
    let hrtimeCallCount = 0

    // Override the hrtime stub to track calls and advance time
    sinon.restore()
    clock = sinon.useFakeTimers()
    sinon.stub(process.hrtime, 'bigint').callsFake(() => {
      const time = BigInt(clock.now) * 1_000_000n
      hrtimeCallCount++
      clock.tick(30) // Advance by 30ms after each call
      return time
    })

    const ctx = {
      deadlineReached: false,
      captureErrors: [],
    }

    const opts = {
      maxReferenceDepth: 5,
      maxCollectionSize: 100,
      maxFieldCount: 100,
      deadlineNs: 50_000_000n, // 50ms (will be exceeded after a few calls)
      ctx,
    }

    // Create an object with multiple nested properties to trigger multiple overBudget checks
    const objWithManyProps = {
      a: { nested: { deep: 1 } },
      b: { nested: { deep: 2 } },
      c: { nested: { deep: 3 } },
      d: { nested: { deep: 4 } },
    }

    const objectId = await getObjectIdForObject(objWithManyProps)
    await collectObjectProperties(objectId, opts, 0)

    // Verify deadline was reached
    assert.strictEqual(ctx.deadlineReached, true)

    // The hrtime should be called at least a couple times
    // but once deadlineReached is cached, it shouldn't be called again
    assert.ok(hrtimeCallCount >= 2, `Expected at least 2 hrtime calls, got ${hrtimeCallCount}`)
  })

  it('should immediately return true for overBudget when deadline already reached', async function () {
    // Advance time past deadline
    clock.tick(200)

    const ctx = {
      deadlineReached: true, // Already marked as reached
      captureErrors: [],
    }

    const opts = {
      maxReferenceDepth: 5,
      maxCollectionSize: 100,
      maxFieldCount: 100,
      deadlineNs: 100_000_000n, // 100ms
      ctx,
    }

    // Track CDP calls to verify we short-circuit
    let cdpCallCount = 0
    const originalPost = session.post.bind(session)
    session.post = function (method, params) {
      if (method === 'Runtime.getProperties') {
        cdpCallCount++
      }
      return originalPost(method, params)
    }

    // Create a nested object that would normally require many CDP calls
    const nestedObj = {
      a: { nested: { deep: 1 } },
      b: { nested: { deep: 2 } },
      c: { nested: { deep: 3 } },
      d: { nested: { deep: 4 } },
    }

    const objectId = await getObjectIdForObject(nestedObj)
    await collectObjectProperties(objectId, opts, 0)

    // Restore original
    session.post = originalPost

    // Verify ctx.deadlineReached remains true
    assert.strictEqual(ctx.deadlineReached, true)

    // Verify we made very few CDP calls (should be 1 for the root object only)
    // If deadline wasn't already reached, this would make many more calls for nested properties
    assert.ok(cdpCallCount <= 1, `Expected at most 1 CDP call due to short-circuit, but made ${cdpCallCount}`)
  })
})

async function getObjectIdForObject (obj) {
  const { result: { objectId } } = await session.post('Runtime.evaluate', { expression: `(${JSON.stringify(obj)})` })
  return objectId
}
