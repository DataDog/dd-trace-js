import { describe, expect, test } from 'vitest'

const RUM_COOKIE_NAME = 'datadog-ci-visibility-test-execution-id'

window.DD_RUM = {
  getInternalContext: () => ({ session_id: 'rum-session' }),
  stopSession: () => {},
}

describe.concurrent('concurrent browser tests', () => {
  test('does not correlate the first inherited concurrent test with RUM', () => {
    expect(getCookie(RUM_COOKIE_NAME)).toBeUndefined()
  })

  test('does not correlate the second inherited concurrent test with RUM', () => {
    expect(getCookie(RUM_COOKIE_NAME)).toBeUndefined()
  })
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
