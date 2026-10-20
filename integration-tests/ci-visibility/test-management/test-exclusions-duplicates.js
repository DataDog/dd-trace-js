'use strict'

const { preventFailureSuppression, noAutoRetry } = require('dd-trace/test-optimization')

if (process.env.EXCLUSIONS_REQUIRE_WORKER === '1' && typeof process.send !== 'function') {
  throw new Error('expected worker IPC')
}

const fail = () => { throw new Error('duplicate declaration failure') }
const callbacks = [preventFailureSuppression(fail), noAutoRetry(() => {}), fail]
if (process.env.EXCLUSIONS_PROTECTED_LAST === '1') callbacks.reverse()
test('same name', callbacks[0])
describe('same', () => test('name', callbacks[1]))
test('same name', callbacks[2])
