'use strict'

const assert = require('node:assert/strict')
const { existsSync, writeFileSync } = require('node:fs')
const { performance } = require('node:perf_hooks')
const { setImmediate } = require('node:timers/promises')

const { When } = require('@cucumber/cucumber')
const sinon = require('sinon')

let elapsed = 0
sinon.stub(performance, 'now').callsFake(() => elapsed)
const attempts = new Map()

When('the outline example {word} runs', async function (outcome) {
  const attempt = (attempts.get(outcome) ?? 0) + 1
  attempts.set(outcome, attempt)
  if (outcome === 'skip') return 'skipped'

  if (this.parameters.synchronize) {
    // Interleave the examples so a name-based accumulator mixes passing and failing attempts.
    writeFileSync(`outline-${outcome}-${attempt}`, '')
    const sibling = outcome === 'pass' ? 'fail' : 'pass'
    while (!existsSync(`outline-${sibling}-${attempt}`)) {
      await setImmediate()
    }
  }
  if (attempt === 1 && outcome === 'pass' && this.parameters.differentBudgets) elapsed += 6000
  assert.strictEqual(outcome, 'pass')
})
