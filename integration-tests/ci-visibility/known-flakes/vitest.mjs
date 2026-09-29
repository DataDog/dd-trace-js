import { test } from 'vitest'

let attempts = 0

test('known flaky failure', () => { throw new Error('known failure') })
test('new failure', () => { throw new Error('new failure') })
test('recovers', () => {
  if (++attempts < 2) throw new Error('intermittent failure')
})
