import { test, expect } from 'vitest'

test('marks the vitest worker process', () => {
  expect(process.env.DD_VITEST_WORKER).to.equal('1')
})
