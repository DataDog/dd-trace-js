'use strict'

const { preventFailureSuppression, noAutoRetry } = require('dd-trace/ci/test-annotations')

function unexpectedExecution () { throw new Error('root setup should prevent execution') }

it('annotated setup skip', preventFailureSuppression(noAutoRetry(unexpectedExecution)))
it('ordinary setup skip', unexpectedExecution)
