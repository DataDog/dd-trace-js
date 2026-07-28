import { afterEach, expect, test } from 'vitest'

let attempts = 0

afterEach(() => {
  throw new Error(`cleanup for attempt ${attempts} failed`)
})

test('reports one attempt when the test and its cleanup fail', () => {
  attempts++
  expect.fail(`test attempt ${attempts} failed`)
})
