'use strict'

const LOCAL_SOCKET_PERMISSION_CODES = new Set(['EACCES', 'EPERM'])
const LOCAL_SOCKET_SYSCALLS = new Set(['connect', 'listen'])
const LOCALHOST_ADDRESSES = new Set(['127.0.0.1', '::1', 'localhost'])

const LOCALHOST_BLOCKED_DIAGNOSIS =
  'The local fake intake could not start because this environment blocks localhost sockets. ' +
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

function getLocalhostBlockedReason () {
  return LOCALHOST_BLOCKED_REASON
}

function getLocalhostBlockedRemediation () {
  return [...LOCALHOST_BLOCKED_REMEDIATION]
}

function buildExecutionEnvironmentBlockerResult ({ framework, error, rerunCommand }) {
  const message = error && error.message ? error.message : String(error)

  return {
    frameworkId: framework.id,
    scenario: 'all',
    status: 'blocked',
    diagnosis: LOCALHOST_BLOCKED_DIAGNOSIS,
    evidence: {
      intakeStarted: false,
      blockedByExecutionEnvironment: true,
      localNetworkingBlocked: true,
      manifestMayBeReused: true,
      reason: LOCALHOST_BLOCKED_REASON,
      error: message,
      errorCode: error?.code,
      errorSyscall: error?.syscall,
      errorAddress: error?.address,
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
  getLocalhostBlockedReason,
  getLocalhostBlockedRemediation,
  isLocalSocketPermissionError,
}
