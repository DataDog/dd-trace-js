import { test } from 'vitest'

let attempts = 0

test('waits for every retry and repeat before quarantining', { repeats: 1, retry: 1 }, () => {
  attempts++
  throw new Error(`retry and repeat attempt ${attempts}`)
})
