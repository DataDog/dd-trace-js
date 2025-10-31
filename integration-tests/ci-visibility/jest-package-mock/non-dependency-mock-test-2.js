'use strict'

// This is to check that the actual package is loaded, to make sure
// that the scenario is the same as the one that was failing.
// Doing it in one of the test suites is enough, as the failure was
// when calling jest.mock('some-package')
const hello = jest.requireActual('some-package')

test('hello function returns correct greeting', () => {
  expect(hello()).toBe('Hello, world!')
})
