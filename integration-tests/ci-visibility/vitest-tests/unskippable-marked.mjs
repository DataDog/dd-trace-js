/* eslint-disable jsdoc/valid-types */
/**
 * @datadog {"unskippable": true}
 */
import { test, expect } from 'vitest'

test('unskippable marked adds three and three', () => {
  expect(3 + 3).toBe(6)
})
