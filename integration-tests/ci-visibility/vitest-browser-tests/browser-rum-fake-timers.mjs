import { afterAll, expect, test } from 'vitest'

const RUM_COOKIE_NAME = 'datadog-ci-visibility-test-execution-id'
let stopSessionCalls = 0

window.DD_RUM = {
  getInternalContext: () => ({ session_id: 'rum-session' }),
  stopSession: () => {
    stopSessionCalls++
  },
}

test('correlates RUM without waiting on the mocked test clock', () => {
  expect(document.cookie).toContain(`${RUM_COOKIE_NAME}=`)
})

afterAll(() => {
  expect(stopSessionCalls).toBe(1)
})
