'use strict'

const { preventFailureSuppression, noAutoRetry } = require('dd-trace/test-optimization')

const excluded = noAutoRetry(() => { throw new Error('excluded duplicate failure') })
const callbacks = [process.env.EXCLUSIONS_COMBINED === '1' ? preventFailureSuppression(excluded) : excluded, () => {}]
if (process.env.EXCLUSIONS_EXCLUDED_LAST === '1') callbacks.reverse()
test('same name', callbacks[0])
test('same name', callbacks[1])
