'use strict'

test('submits a Jest console warning', () => {
  // eslint-disable-next-line no-console
  console.warn('Jest console warning: %s', 'details')
})
