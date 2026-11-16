import { expect, test } from 'vitest'

test('repeats a new browser test', () => {
  expect(true).toBe(true)
})

test('attempts to fix a browser test', () => {
  expect(true).toBe(true)
})

test('does not execute a disabled browser test', () => {
  throw new Error('disabled browser test was executed')
})

test('quarantines a failing browser test', () => {
  expect(true).toBe(false)
})
