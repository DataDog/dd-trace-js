'use strict'

const assert = require('node:assert/strict')

const {
  filterFrameworks,
  normalizeFrameworkTarget,
  parseArgs,
} = require('../../../../ci/test-optimization-validation/cli')

describe('test optimization validation cli', () => {
  it('normalizes copied framework targets with a trailing colon', () => {
    assert.strictEqual(normalizeFrameworkTarget(' vitest:root-unit: '), 'vitest:root-unit')

    const options = parseArgs(['--framework', 'vitest:root-unit:'])

    assert.deepStrictEqual([...options.frameworks], ['vitest:root-unit'])
  })

  it('selects entries by exact id or framework kind', () => {
    const frameworks = [
      { id: 'vitest:root-unit', framework: 'vitest' },
      { id: 'mocha:cjs-module', framework: 'mocha' },
      { id: 'vitest:integration', framework: 'vitest' },
    ]

    assert.deepStrictEqual(filterFrameworks(frameworks, new Set(['vitest:root-unit'])), [
      { id: 'vitest:root-unit', framework: 'vitest' },
    ])
    assert.deepStrictEqual(filterFrameworks(frameworks, new Set(['vitest'])), [
      { id: 'vitest:root-unit', framework: 'vitest' },
      { id: 'vitest:integration', framework: 'vitest' },
    ])
  })
})
