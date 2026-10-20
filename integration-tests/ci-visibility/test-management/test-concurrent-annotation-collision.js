'use strict'

const { noAutoRetry, preventFailureSuppression } = require('dd-trace/test-optimization')
const policy = process.env.EXCLUSIONS_COLLISION_POLICY
let attempts = 0
const declareSerial = () => test('same name', () => {
  if (policy !== 'retries' || ++attempts < 3) throw new Error('ordinary serial failure')
})
const declareConcurrent = () => test.concurrent('same name',
  (policy === 'retries' ? noAutoRetry : preventFailureSuppression)(async () => { expect(42).toBe(42) }))
if (process.env.EXCLUSIONS_SERIAL_FIRST === '1') {
  declareSerial()
  declareConcurrent()
} else {
  declareConcurrent()
  declareSerial()
}
