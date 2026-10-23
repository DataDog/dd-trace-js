import { test } from 'vitest'

test('second run failure', () => {
  throw new Error('second run failure')
})
