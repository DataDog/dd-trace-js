import { test } from 'vitest'

test('first run failure', () => {
  throw new Error('first run failure')
})
