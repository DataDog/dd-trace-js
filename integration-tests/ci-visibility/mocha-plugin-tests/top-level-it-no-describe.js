'use strict'

// Deliberately no describe() wrapper.
// Tests are direct children of mocha's root suite.
// This is the structure that exposes the suite-not-reported bug:
// the 'suite' event handler in mocha/main.js only runs testSuiteStartCh
// for non-root suites with suite.tests.length > 0. When there are no
// non-root suites at all, no suite context is ever created and
// no test_suite_end event is emitted.
it('top-level passing test', () => {})

it('top-level passing test two', () => {})
