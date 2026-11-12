import { beforeEach, expect } from 'vitest'

const RUM_COOKIE_NAME = 'datadog-ci-visibility-test-execution-id'
let isRumActive = true

window.DD_RUM = {
  getInternalContext: () => isRumActive ? { session_id: 'rum-session' } : undefined,
  stopSession: () => {
    isRumActive = false
  },
}

beforeEach(() => {
  const testExecutionId = getCookie(RUM_COOKIE_NAME)
  expect(testExecutionId).toMatch(/^[1-9]\d*$/)
  // eslint-disable-next-line no-console
  console.log(`DD_VITEST_RUM_EXECUTION_ID:user-setup:${testExecutionId}`)
})

function getCookie (name) {
  const prefix = `${name}=`
  for (const cookie of document.cookie.split(';')) {
    const normalizedCookie = cookie.trim()
    if (normalizedCookie.startsWith(prefix)) {
      return normalizedCookie.slice(prefix.length)
    }
  }
}
