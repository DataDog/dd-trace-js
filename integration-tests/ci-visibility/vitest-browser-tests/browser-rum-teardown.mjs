import { afterEach, expect, test } from 'vitest'

const RUM_COOKIE_NAME = 'datadog-ci-visibility-test-execution-id'

afterEach(() => {
  expect(document.cookie).toContain(`${RUM_COOKIE_NAME}=`)
  window.DD_RUM = {
    getInternalContext: () => ({ session_id: 'rum-session' }),
  }
})

test('keeps RUM correlation active through user teardown hooks', () => {
  expect(window.DD_RUM).toBeUndefined()
})
