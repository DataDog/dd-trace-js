'use strict'

const { it, xit, test } = require('mocha')
const { preventFailureSuppression, noAutoRetry } = require('dd-trace/test-optimization')

const callback = preventFailureSuppression(noAutoRetry(() => { throw new Error('must remain skipped') }))
it.skip('imported skip', callback)
xit('imported xit', callback)
test.skip('imported test', callback)
it('live control', () => {})
