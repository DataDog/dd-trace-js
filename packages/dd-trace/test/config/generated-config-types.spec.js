'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')

const { describe, it } = require('mocha')

const {
  generateConfigTypes,
  OUTPUT_PATH,
} = require('../../../../scripts/generate-config-types')

// TODO: Re-enable when landing the actual change.
describe.skip('generated config types', () => {
  it('should stay in sync with supported-configurations.json', () => {
    assert.strictEqual(
      readFileSync(OUTPUT_PATH, 'utf8').replaceAll('\r\n', '\n'),
      generateConfigTypes()
    )
  })
})
