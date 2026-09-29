import { describe, test } from 'vitest'

let attempts = 0

test('known flaky failure', () => { throw new Error('known failure') })
const fail = () => { throw new Error('new failure') }
if (process.env.NATIVE_SUITE_RETRIES) {
  describe('native suite', { retry: 2 }, () => test('new failure', fail))
} else {
  test('new failure', { retry: process.env.PER_TEST_RETRIES ? Number(process.env.PER_TEST_RETRIES) : undefined }, fail)
}
test('recovers', () => {
  if (++attempts < 2) throw new Error('intermittent failure')
})
