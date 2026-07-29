import { expect, test } from 'vitest'

const RUM_COOKIE_NAME = 'datadog-ci-visibility-test-execution-id'

window.DD_RUM = {
  getInternalContext: () => ({ session_id: 'rum-session' }),
}

test('correlates the first fixed browser crypto value', () => {
  const testExecutionId = getCookie(RUM_COOKIE_NAME)
  expect(testExecutionId).toMatch(/^[1-9]\d*$/)
  // eslint-disable-next-line no-console
  console.log(`DD_VITEST_RUM_EXECUTION_ID:fixed:${testExecutionId}`)
})

test('does not reuse a fixed browser crypto value', () => {
  expect(getCookie(RUM_COOKIE_NAME)).toBeUndefined()
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
