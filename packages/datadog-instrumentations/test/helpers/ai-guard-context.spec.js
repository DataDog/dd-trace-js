'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

const { runWithAIGuardContext, isAIGuardContextActive } = require('../../src/helpers/ai-guard-context')

describe('ai-guard-context', () => {
  it('reports inactive outside of any scope', () => {
    assert.strictEqual(isAIGuardContextActive(), false)
  })

  it('reports active inside a scope', () => {
    let insideActive
    runWithAIGuardContext(() => {
      insideActive = isAIGuardContextActive()
    })
    assert.strictEqual(insideActive, true)
  })

  it('restores inactive after the scope returns', () => {
    runWithAIGuardContext(() => {})
    assert.strictEqual(isAIGuardContextActive(), false)
  })

  it('propagates across awaited microtasks', async () => {
    const observed = []
    await runWithAIGuardContext(async () => {
      observed.push(isAIGuardContextActive())
      await Promise.resolve()
      observed.push(isAIGuardContextActive())
    })
    assert.deepStrictEqual(observed, [true, true])
    assert.strictEqual(isAIGuardContextActive(), false)
  })

  it('does not leak across sibling async chains', async () => {
    // Two concurrent chains: one runs inside the context, one outside. Each must see
    // only its own scope's flag.
    let insideSeen
    let outsideSeen
    const inside = runWithAIGuardContext(async () => {
      await new Promise(resolve => setImmediate(resolve))
      insideSeen = isAIGuardContextActive()
    })
    const outside = (async () => {
      await new Promise(resolve => setImmediate(resolve))
      outsideSeen = isAIGuardContextActive()
    })()

    await Promise.all([inside, outside])
    assert.strictEqual(insideSeen, true)
    assert.strictEqual(outsideSeen, false)
  })

  it('returns the inner function value', () => {
    const value = runWithAIGuardContext(() => 42)
    assert.strictEqual(value, 42)
  })
})
