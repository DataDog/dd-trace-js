import { expect, test, vi } from 'vitest'

const RUM_COOKIE_NAME = 'datadog-ci-visibility-test-execution-id'
let attempts = 0

window.DD_RUM = {
  getInternalContext: () => ({ session_id: 'rum-session' }),
}

test('does not reuse RUM correlation when a retry is dynamically skipped', { retry: 1 }, ({ skip }) => {
  attempts++
  if (attempts === 1) {
    const testExecutionId = getCookie(RUM_COOKIE_NAME)
    expect(testExecutionId).toMatch(/^[1-9]\d*$/)
    // eslint-disable-next-line no-console
    console.log(`DD_VITEST_RUM_EXECUTION_ID:retry-skip:${testExecutionId}`)
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => {
      throw new Error('Browser crypto is unavailable for the retry')
    })
    throw new Error('Retry before dynamically skipping')
  }

  vi.restoreAllMocks()
  expect(getCookie(RUM_COOKIE_NAME)).toBeUndefined()
  skip()
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
