import { expect, test } from 'vitest'

const RUM_COOKIE_NAME = 'datadog-ci-visibility-test-execution-id'

window.DD_RUM = {
  getInternalContext: () => ({ session_id: 'rum-session' }),
}

test('does not correlate the first parallel browser file with RUM', () => {
  expect(document.cookie).not.toContain(`${RUM_COOKIE_NAME}=`)
})
