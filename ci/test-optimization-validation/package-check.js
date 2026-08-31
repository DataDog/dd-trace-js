'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const { BLOCKER_CATEGORIES } = require('./blocker-category')
const { getBaseEnv } = require('./command-runner')
const { sanitizeString } = require('./redaction')

const DEFAULT_PACKAGE_ROOT = path.resolve(__dirname, '..', '..')
const LOAD_MARKER = 'dd-trace-test-optimization-package-check-ok'
const MAX_OUTPUT_BYTES = 64 * 1024
const TIMEOUT_MS = 10_000

// Loads the initialization entrypoint in an isolated child without initializing tracing.
function checkInstalledPackage ({ packageRoot = DEFAULT_PACKAGE_ROOT } = {}) {
  const root = path.resolve(packageRoot)
  const initPath = path.join(root, 'ci', 'init.js')
  const script = [
    `require(${JSON.stringify(initPath)})`,
    `process.stdout.write(${JSON.stringify(LOAD_MARKER)})`,
    'process.exit(0)',
  ].join(';')
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...getBaseEnv('clean'),
      DD_CIVISIBILITY_ENABLED: 'false',
      DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
      DD_PROFILING_ENABLED: 'false',
      DD_REMOTE_CONFIGURATION_ENABLED: 'false',
      DD_TRACE_ENABLED: 'false',
      NODE_OPTIONS: '',
    },
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: false,
    timeout: TIMEOUT_MS,
    windowsHide: true,
  })

  if (!result.error && result.status === 0 && result.stdout.includes(LOAD_MARKER)) {
    return {
      ok: true,
      diagnosis: 'The installed dd-trace package loaded its Test Optimization initialization entrypoint.',
    }
  }

  const detail = getFailureDetail(result)
  return {
    ok: false,
    diagnosis: 'The installed dd-trace package could not load its Test Optimization initialization entrypoint' +
      (detail ? `: ${detail}` : '.'),
    recommendation: 'Reinstall dd-trace through the project\'s normal dependency workflow, then create a fresh ' +
      'validation plan. If the load check still fails, report it as an installed-package problem without running ' +
      'tests.',
  }
}

function getInstalledPackageFailure (framework, packageCheck) {
  return {
    frameworkId: framework.id,
    scenario: 'basic-reporting',
    status: 'blocked',
    diagnosis: `${packageCheck.diagnosis} No project test was run and no library-compatibility conclusion was reached.`,
    evidence: {
      blockerCategory: BLOCKER_CATEGORIES.PROJECT_SETUP_REQUIRED,
      blockedByProjectSetup: true,
      installedPackageIncomplete: true,
      recommendation: packageCheck.recommendation,
      validationIncomplete: true,
    },
    artifacts: [],
  }
}

function getFailureDetail (result) {
  if (result.error?.code === 'ETIMEDOUT') return `the isolated load check exceeded ${TIMEOUT_MS} ms.`
  if (result.error) return `${sanitizeLine(result.error.message)}.`

  const output = `${result.stderr || ''}\n${result.stdout || ''}`
  const line = output.split(/\r?\n/).map(value => value.trim()).find(value => {
    return /^(?:Error:|.*(?:MODULE_NOT_FOUND|Cannot find (?:module|package)|ERR_[A-Z_]+))/.test(value)
  })
  if (line) return `${sanitizeLine(line)}.`
  if (result.signal) return `the isolated load check exited after signal ${sanitizeLine(result.signal)}.`
  return `the isolated load check exited ${result.status ?? 'without a status'}.`
}

function sanitizeLine (value) {
  return sanitizeString(String(value)).replaceAll(/\p{Cc}+/gu, ' ').trim().slice(0, 1000).replace(/[.]+$/, '')
}

module.exports = { checkInstalledPackage, getInstalledPackageFailure }
