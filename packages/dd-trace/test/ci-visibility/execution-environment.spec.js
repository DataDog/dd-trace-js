'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const {
  buildExecutionEnvironmentBlockerResult,
  checkLocalhostCapability,
  isLocalSocketPermissionError,
} = require('../../../../ci/test-optimization-validation/execution-environment')

describe('test optimization execution environment diagnosis', () => {
  it('checks localhost listen and connect capability without leaving sockets open', async () => {
    let clientDestroyed = false
    let serverClosed = false
    const server = Object.assign(new EventEmitter(), {
      listening: false,
      listen (port, host, callback) {
        assert.strictEqual(port, 0)
        assert.strictEqual(host, '127.0.0.1')
        this.listening = true
        queueMicrotask(callback)
      },
      address () {
        return { port: 43210 }
      },
      close (callback) {
        this.listening = false
        serverClosed = true
        queueMicrotask(callback)
      },
    })
    const client = Object.assign(new EventEmitter(), {
      destroy () {
        clientDestroyed = true
      },
    })
    const netModule = {
      createServer () {
        return server
      },
      createConnection (options) {
        assert.deepStrictEqual(options, { host: '127.0.0.1', port: 43210 })
        queueMicrotask(() => client.emit('connect'))
        return client
      },
    }

    await checkLocalhostCapability({ netModule })

    assert.strictEqual(clientDestroyed, true)
    assert.strictEqual(serverClosed, true)
  })

  it('preserves localhost listen permission errors from the capability check', async () => {
    const error = Object.assign(new Error('listen EPERM 127.0.0.1'), {
      address: '127.0.0.1',
      code: 'EPERM',
      syscall: 'listen',
    })
    const server = Object.assign(new EventEmitter(), {
      listening: false,
      listen () {
        queueMicrotask(() => this.emit('error', error))
      },
    })

    await assert.rejects(checkLocalhostCapability({
      netModule: {
        createServer () {
          return server
        },
      },
    }), candidate => candidate === error)
  })

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
      approvedPlanSha256: 'a'.repeat(64),
      workingDirectory: '/repo',
    })

    assert.strictEqual(isLocalSocketPermissionError(error), true)
    assert.strictEqual(result.frameworkId, 'jest:root')
    assert.strictEqual(result.scenario, 'all')
    assert.strictEqual(result.status, 'blocked')
    assert.match(result.diagnosis, /not evidence that Test Optimization is misconfigured/)
    assert.strictEqual(result.evidence.blockedByExecutionEnvironment, true)
    assert.strictEqual(result.evidence.localNetworkingBlocked, true)
    assert.strictEqual(result.evidence.manifestMayBeReused, true)
    assert.strictEqual(result.evidence.projectCommandsRan, false)
    assert.strictEqual(result.evidence.workingDirectory, '/repo')
    assert.strictEqual(result.evidence.approvedPlanSha256, 'a'.repeat(64))
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
