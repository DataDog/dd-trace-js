import { expect, test } from 'vitest'

window.DD_RUM = {}

test('does not activate RUM correlation for an uninitialized stub', () => {
  expect(document.cookie).toContain('datadog-ci-visibility-test-execution-id=')
})
