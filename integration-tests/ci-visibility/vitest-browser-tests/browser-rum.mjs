import { afterAll, describe, expect, test } from 'vitest'

const RUM_COOKIE_NAME = 'datadog-ci-visibility-test-execution-id'
const rumState = {
  isActive: true,
  startViewCalls: 0,
  stopSessionCalls: 0,
}
let retryAttempts = 0

window.DD_RUM = {
  getInternalContext: () => rumState.isActive ? { session_id: 'rum-session' } : undefined,
  startView: () => {
    rumState.isActive = true
    rumState.startViewCalls++
  },
  stopSession: () => {
    rumState.isActive = false
    rumState.stopSessionCalls++
  },
}

describe('vitest browser RUM correlation', () => {
  test('correlates the first browser test', () => {
    assertAndLogExecutionId('first')
  })

  test('uses a new correlation ID after restarting RUM', () => {
    assertAndLogExecutionId('second')
  })

  test('uses a new RUM correlation ID on retry', () => {
    retryAttempts++
    assertAndLogExecutionId(`retry-${retryAttempts}`)
    expect(retryAttempts).toBe(2)
  })
})

afterAll(() => {
  expect(getCookie(RUM_COOKIE_NAME)).toBeUndefined()
  expect(rumState.startViewCalls).toBe(3)
  expect(rumState.stopSessionCalls).toBe(4)
})

function assertAndLogExecutionId (testName) {
  const testExecutionId = getCookie(RUM_COOKIE_NAME)
  expect(testExecutionId).toMatch(/^[1-9]\d*$/)
  // eslint-disable-next-line no-console
  console.log(`DD_VITEST_RUM_EXECUTION_ID:${testName}:${testExecutionId}`)
}

function getCookie (name) {
  const prefix = `${name}=`
  for (const cookie of document.cookie.split(';')) {
    const normalizedCookie = cookie.trim()
    if (normalizedCookie.startsWith(prefix)) {
      return normalizedCookie.slice(prefix.length)
    }
  }
}
