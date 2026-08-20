/* eslint-disable jsdoc/valid-types */
/**
 * @datadog {"unskippable": true}
 */
import { describe, expect, it } from 'vitest'

describe('TIA unskippable suite', () => {
  it('runs when selected for skipping', () => {
    expect(1 + 2).toBe(3)
  })
})
