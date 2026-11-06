'use strict'

/* eslint-disable mocha/no-identical-title -- duplicate titles verify per-execution policy */

const { preventFailureSuppression, noAutoRetry } = require('dd-trace/ci/test-annotations')

it('duplicate', preventFailureSuppression(() => { throw new Error('protected failure') }))
it('duplicate', noAutoRetry(() => {}))
it('duplicate', () => { throw new Error('ordinary quarantine failure') })
