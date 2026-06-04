/* eslint-disable sonarjs/stable-tests */
import { describe, expect, test } from 'vitest'

let attempt = 0

describe('efd with manual vitest retries', () => {
  test('fails first then passes', () => {
    expect(attempt++).to.equal(2)
  })
})
