'use strict'

jest.mock('some-package', () => {
  return jest.fn(() => 'Hello, mocked world!')
})
