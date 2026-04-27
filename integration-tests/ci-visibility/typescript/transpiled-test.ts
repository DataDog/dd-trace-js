import assert = require('node:assert/strict')

import { multiply } from './transpiled-module'

type MultiplicationScenario = {
  left: number
  right: number
  expected: number
}

describe('transpiled TypeScript coverage', () => {
  it('runs TypeScript tests through a runtime transpiler', () => {
    const scenario: MultiplicationScenario = {
      left: 6,
      right: 7,
      expected: 42,
    }

    assert.strictEqual(multiply(scenario.left, scenario.right), scenario.expected)
  })
})
