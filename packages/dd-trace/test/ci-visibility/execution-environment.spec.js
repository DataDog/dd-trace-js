'use strict'

const assert = require('node:assert/strict')

const {
  buildExecutionEnvironmentBlockerResult,
  isLocalSocketPermissionError,
} = require('../../../../ci/test-optimization-validation/execution-environment')

describe('test optimization execution environment diagnosis', () => {
  it('turns fake intake EPERM listen failures into execution-environment blockers', () => {
    const error = Object.assign(new Error('listen EPERM: operation not permitted 127.0.0.1'), {
      address: '127.0.0.1',
      code: 'EPERM',
      syscall: 'listen',
    })
    const result = buildExecutionEnvironmentBlockerResult({
      framework: { id: 'jest:root' },
      error,
      rerunCommand: 'node /repo/node_modules/dd-trace/ci/validate-test-optimization.js --manifest manifest.json',
    })

    assert.strictEqual(isLocalSocketPermissionError(error), true)
    assert.strictEqual(result.frameworkId, 'jest:root')
    assert.strictEqual(result.scenario, 'all')
    assert.strictEqual(result.status, 'blocked')
    assert.match(result.diagnosis, /not evidence that Test Optimization is misconfigured/)
    assert.strictEqual(result.evidence.blockedByExecutionEnvironment, true)
    assert.strictEqual(result.evidence.localNetworkingBlocked, true)
    assert.strictEqual(result.evidence.manifestMayBeReused, true)
    assert.strictEqual(result.evidence.errorCode, 'EPERM')
    assert.strictEqual(result.evidence.errorSyscall, 'listen')
    assert.deepStrictEqual(result.evidence.remediation, [
      'Rerun the validator command shown below from the host shell',
      'Rerun in an agent mode that allows localhost sockets while retaining credential, outbound-network, and ' +
        'filesystem restrictions',
      'Rerun in CI',
    ])
  })

  it('recognizes fake intake EACCES listen failures as local socket permission errors', () => {
    const error = Object.assign(new Error('listen EACCES: permission denied 127.0.0.1'), {
      address: '127.0.0.1',
      code: 'EACCES',
      syscall: 'listen',
    })

    assert.strictEqual(isLocalSocketPermissionError(error), true)
  })

  it('recognizes localhost connect permission errors from the live-validation preflight', () => {
    const error = Object.assign(new Error('connect EPERM 127.0.0.1:49321'), {
      address: '127.0.0.1',
      code: 'EPERM',
      syscall: 'connect',
    })

    assert.strictEqual(isLocalSocketPermissionError(error), true)
  })

  it('does not classify non-local permission errors as localhost sandbox blockers', () => {
    const error = Object.assign(new Error('connect EPERM 10.0.0.1:443'), {
      address: '10.0.0.1',
      code: 'EPERM',
      syscall: 'connect',
    })

    assert.strictEqual(isLocalSocketPermissionError(error), false)
  })
})
