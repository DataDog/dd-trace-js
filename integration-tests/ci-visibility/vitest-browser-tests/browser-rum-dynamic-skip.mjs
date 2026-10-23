import { afterAll, expect, test } from 'vitest'

const RUM_COOKIE_NAME = 'datadog-ci-visibility-test-execution-id'

window.DD_RUM = {
  getInternalContext: () => ({ session_id: 'rum-session' }),
}

test('correlates a dynamically skipped browser test', async ({ skip }) => {
  const testExecutionId = getCookie(RUM_COOKIE_NAME)
  expect(testExecutionId).toMatch(/^[1-9]\d*$/)
  // eslint-disable-next-line no-console
  console.log(`DD_VITEST_RUM_EXECUTION_ID:dynamic-skip:${testExecutionId}`)
  await new Promise(resolve => setTimeout(resolve, 50))
  // eslint-disable-next-line no-console
  console.log(`DD_VITEST_SKIP_TIME:${Date.now()}`)
  skip()
})

afterAll(async () => {
  await new Promise(resolve => setTimeout(resolve, 100))
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
