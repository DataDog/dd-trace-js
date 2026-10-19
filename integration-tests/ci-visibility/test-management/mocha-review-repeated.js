'use strict'

const { preventFailureSuppression } = require('dd-trace/test-optimization')

const first = process.env.MOCHA_REVIEW_RUN === '1'
const callback = () => { if (!first) throw new Error('quarantine after removing protection') }
it('same test', first ? preventFailureSuppression(callback) : callback)
