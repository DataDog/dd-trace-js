'use strict'

const { noAutoRetry, preventFailureSuppression } = require('dd-trace/test-optimization')

const failingRows = test.failing.each([[1]])

// failing.each does not support done callbacks, even when the source callback declares an extra argument.
failingRows('ordinary failing row %s', (value, unused) => {}, 100)
failingRows('excluded failing row %s', noAutoRetry((value, unused) => {}), 100)
failingRows('protected failing row %s', preventFailureSuppression((value, unused) => {}), 100)
