import { expect, test } from 'vitest'

let executions = 0

test('repeats a new browser test', () => {
  executions++
  expect(executions).toBeGreaterThan(0)
})
