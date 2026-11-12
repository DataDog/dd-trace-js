/* eslint-disable jsdoc/valid-types -- @datadog accepts a JSON value rather than a JSDoc type. */
/**
 * @datadog {"unskippable": true}
 */
'use strict'

// Fixture for jest.spec.js. `getJestSuitesToRun` reads this file to scan for
// the `@datadog` docblock above; the body of the suite is never executed.

describe('test-unskippable', () => {
  it('is a placeholder fixture', () => {})
})
