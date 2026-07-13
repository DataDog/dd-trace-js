'use strict'

const net = require('node:net')

const LOCAL_SOCKET_PERMISSION_CODES = new Set(['EACCES', 'EPERM'])
const LOCAL_SOCKET_SYSCALLS = new Set(['connect', 'listen'])
const LOCALHOST_ADDRESSES = new Set(['127.0.0.1', '::1', 'localhost'])

const LOCALHOST_BLOCKED_DIAGNOSIS =
  'Validation was blocked before any project command ran. The local fake intake could not start because this ' +
  'environment blocks localhost sockets. ' +
  'This is not evidence that Test Optimization is misconfigured. No Test Optimization conclusion was reached.'

const LOCALHOST_BLOCKED_REASON =
  'The current agent sandbox blocks localhost sockets, so the validator could not start the fake Datadog intake.'

const LOCALHOST_BLOCKED_REMEDIATION = [
  'Rerun the validator command shown below from the host shell',
  'Rerun in an agent mode that allows localhost sockets while retaining credential, outbound-network, and ' +
    'filesystem restrictions',
  'Rerun in CI',
]

function isLocalSocketPermissionError (err) {
  if (!err || !LOCAL_SOCKET_PERMISSION_CODES.has(err.code) || !LOCAL_SOCKET_SYSCALLS.has(err.syscall)) {
    return false
  }

  if (isLocalhostAddress(err.address) || includesLocalhost(err.message)) {
    return true
  }

  // The validator only binds the fake intake to 127.0.0.1, so a permission denied listen error
  // without an address is still a local socket execution-environment blocker.
  return err.syscall === 'listen' && err.address === undefined
}

/**
 * Checks whether the current process can listen and connect on localhost.
 *
 * @param {object} [options] - Capability check options.
 * @param {typeof net} [options.netModule] - Network implementation used by focused tests.
 * @returns {Promise<void>} Resolves when both localhost operations succeed.
 */
function checkLocalhostCapability ({ netModule = net } = {}) {
  return new Promise((resolve, reject) => {
    let client
    let settled = false
    let server

    const settle = (error) => {
      if (settled) return
      settled = true
      client?.destroy()

      const complete = closeError => error || closeError ? reject(error || closeError) : resolve()
      if (server?.listening) {
        try {
          server.close(complete)
        } catch (closeError) {
          complete(error || closeError)
        }
      } else {
        complete()
      }
    }

    try {
      server = netModule.createServer()
      server.once('error', settle)
      server.listen(0, '127.0.0.1', () => {
        try {
          const address = server.address()
          client = netModule.createConnection({ host: '127.0.0.1', port: address.port })
          client.once('connect', () => settle())
          client.once('error', settle)
        } catch (error) {
          settle(error)
        }
      })
    } catch (error) {
      settle(error)
    }
  })
}

function getLocalhostBlockedReason () {
  return LOCALHOST_BLOCKED_REASON
}

function getLocalhostBlockedRemediation () {
  return [...LOCALHOST_BLOCKED_REMEDIATION]
}

function buildExecutionEnvironmentBlockerResult ({
  framework,
  error,
  rerunCommand,
  approvedPlanSha256,
  workingDirectory,
}) {
  const message = error && error.message ? error.message : String(error)

  return {
    frameworkId: framework.id,
    scenario: 'all',
    status: 'blocked',
    diagnosis: LOCALHOST_BLOCKED_DIAGNOSIS,
    evidence: {
      intakeStarted: false,
      projectCommandsRan: false,
      blockedByExecutionEnvironment: true,
      localNetworkingBlocked: true,
      manifestMayBeReused: true,
      reason: LOCALHOST_BLOCKED_REASON,
      error: message,
      errorCode: error?.code,
      errorSyscall: error?.syscall,
      errorAddress: error?.address,
      approvedPlanSha256,
      workingDirectory,
      remediation: getLocalhostBlockedRemediation(),
      rerunCommand,
    },
    artifacts: [],
  }
}

function isLocalhostAddress (address) {
  return address !== undefined && LOCALHOST_ADDRESSES.has(String(address).toLowerCase())
}

function includesLocalhost (message) {
  return /(?:127\.0\.0\.1|localhost|\[?::1\]?)/.test(String(message || '').toLowerCase())
}

module.exports = {
  buildExecutionEnvironmentBlockerResult,
  checkLocalhostCapability,
  getLocalhostBlockedReason,
  getLocalhostBlockedRemediation,
  isLocalSocketPermissionError,
}
