'use strict'

const path = require('path')
const fs = require('fs')
const assert = require('assert')
const {
  runAndCheckWithTelemetry: testFile,
  useEnv,
  useSandbox,
  sandboxCwd,
} = require('./helpers')

const NODE_OPTIONS = '--require dd-trace/init.js'
const DD_TRACE_DEBUG = 'true'
const DD_INJECTION_ENABLED = 'tracing'
const DD_LOG_LEVEL = 'info'
const DD_TRACE_FLUSH_INTERVAL = '0'
const NODE_MAJOR = Number(process.versions.node.split('.')[0])
const FASTIFY_DEP = NODE_MAJOR < 20 ? 'fastify@4' : 'fastify'

// These are on by default in release tests, so we'll turn them off for
// more fine-grained control of these variables in these tests.
delete process.env.DD_INJECTION_ENABLED
delete process.env.DD_INJECT_FORCE

/**
 * Creates a sandbox with runtime guardrails disabled so this spec only tests package guardrails.
 *
 * @param {string[]} dependencies
 * @param {boolean} isGitRepo
 * @param {string[]} integrationTestsPaths
 * @param {string} [followUpCommand]
 * @returns {void}
 */
function useRuntimeSupportedSandbox (
  dependencies = [],
  isGitRepo = false,
  integrationTestsPaths = ['./integration-tests/*'],
  followUpCommand
) {
  useSandbox(dependencies, isGitRepo, integrationTestsPaths, followUpCommand)

  before(() => {
    const packagePath = path.join(sandboxCwd(), 'node_modules/dd-trace/package.json')
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
    pkg.engines.node = '>=0'
    pkg.nodeMaxMajor = 1000
    fs.writeFileSync(packagePath, JSON.stringify(pkg))
  })
}

describe('package guardrails', () => {
  useEnv({ NODE_OPTIONS })
  const runTest = (expectedOut, expectedTelemetryPoints, expectedSource = '') =>
    testFile('package-guardrails/index.js', expectedOut, expectedTelemetryPoints, expectedSource)

  context('when package is out of range', () => {
    useRuntimeSupportedSandbox(['bluebird@1.0.0'])

    context('with DD_INJECTION_ENABLED', () => {
      useEnv({ DD_INJECTION_ENABLED })

      it('should not instrument the package, and send telemetry', () =>
        runTest('false\n',
          ['complete', 'injection_forced:false',
            'abort.integration', 'integration:bluebird,integration_version:1.0.0',
          ]
        ))
    })

    context('when flushing and DD_INJECTION_ENABLED', () => {
      useEnv({ DD_INJECTION_ENABLED, DD_TRACE_FLUSH_INTERVAL })

      it('should send abort.integration on first flush via diagnostic channel', () =>
        testFile('package-guardrails/flush.js', 'false\n',
          ['complete', 'injection_forced:false',
            'abort.integration', 'integration:bluebird,integration_version:1.0.0',
          ]
        ))
    })

    context('with logging disabled', () => {
      it('should not instrument the package', () => runTest('false\n', []))
    })

    context('with logging enabled', () => {
      useEnv({ DD_TRACE_DEBUG })

      it('should not instrument the package', () =>
        runTest(`Application instrumentation bootstrapping complete
false
instrumentation source: manual
Found incompatible integration version: bluebird@1.0.0
`, []))
    })
  })

  context('when package is in range', () => {
    context('when bluebird is 2.9.0', () => {
      useRuntimeSupportedSandbox(['bluebird@2.9.0'])

      it('should instrument the package', () => runTest('true\n', [], 'manual'))
    })

    context('when bluebird is 3.7.2', () => {
      useRuntimeSupportedSandbox(['bluebird@3.7.2'])

      it('should instrument the package', () => runTest('true\n', [], 'manual'))
    })
  })

  context('when package is in range (fastify)', () => {
    context('when fastify is latest', () => {
      useRuntimeSupportedSandbox([FASTIFY_DEP])

      it('should instrument the package', () => runTest('true\n', [], 'manual'))
    })

    context('when fastify is latest and logging enabled', () => {
      useRuntimeSupportedSandbox([FASTIFY_DEP])
      useEnv({ DD_TRACE_DEBUG })

      it('should instrument the package', () =>
        runTest('Application instrumentation bootstrapping complete\ntrue\n', [], 'manual'))
    })
  })

  context('when package errors out', () => {
    useRuntimeSupportedSandbox(['bluebird'])

    before(() => {
      const file = path.join(sandboxCwd(), 'node_modules/dd-trace/packages/datadog-instrumentations/src/bluebird.js')
      fs.writeFileSync(file, `
const { addHook } = require('./helpers/instrument')

addHook({ name: 'bluebird', versions: ['*'] }, Promise => {
  throw new ReferenceError('this is a test error')
  return Promise
})
      `)
    })

    context('with DD_INJECTION_ENABLED', () => {
      useEnv({ DD_INJECTION_ENABLED })

      it('should not instrument the package, and send telemetry', () =>
        runTest('false\n',
          ['complete', 'injection_forced:false',
            'error', 'error_type:ReferenceError,integration:bluebird,integration_version:3.7.2']
        ))
    })

    context('with logging disabled', () => {
      it('should not instrument the package', () => runTest('false\n', []))
    })

    context('with logging enabled', () => {
      useEnv({ DD_TRACE_DEBUG, DD_LOG_LEVEL })

      it('should not instrument the package', () =>
        runTest(
          log => {
            assert.match(
              log,
              /\nError during ddtrace instrumentation of application, aborting.\nReferenceError: this is a test error\n {4}at /m
            )
            assert.match(log, /\nfalse\n/)
          }, []))
    })
  })
})
