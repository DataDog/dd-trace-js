import { expect, test } from 'vitest'

const RUM_COOKIE_NAME = 'datadog-ci-visibility-test-execution-id'

window.DD_RUM = {
  getInternalContext: () => ({ session_id: 'rum-session' }),
}

test('does not fail when browser crypto throws', () => {
  expect(document.cookie).not.toContain(`${RUM_COOKIE_NAME}=`)
})

test('does not retry ID generation when browser crypto returns zero', () => {
  expect(document.cookie).not.toContain(`${RUM_COOKIE_NAME}=`)
})
