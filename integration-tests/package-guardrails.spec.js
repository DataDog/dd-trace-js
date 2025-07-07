const {
  runAndCheckWithTelemetry: testFile,
  useEnv,
  useSandbox,
  sandboxCwd
} = require('./helpers')
const path = require('path')
const fs = require('fs')
const assert = require('assert')

const NODE_OPTIONS = '--require dd-trace/init.js'
const DD_TRACE_DEBUG = 'true'
const DD_INJECTION_ENABLED = 'tracing'
const DD_LOG_LEVEL = 'error'

// These are on by default in release tests, so we'll turn them off for
// more fine-grained control of these variables in these tests.
delete process.env.DD_INJECTION_ENABLED
delete process.env.DD_INJECT_FORCE

describe('package guardrails', () => {
  useEnv({ NODE_OPTIONS })
  const runTest = (...args) =>
    testFile('package-guardrails/index.js', ...args)

  context('when package is out of range', () => {
    useSandbox(['bluebird@1.0.0'])
    context('with DD_INJECTION_ENABLED', () => {
      useEnv({ DD_INJECTION_ENABLED })
      it('should not instrument the package, and send telemetry', () =>
        runTest('false\n',
          ['complete', 'injection_forced:false',
            'abort.integration', 'integration:bluebird,integration_version:1.0.0'
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
Found incompatible integration version: bluebird@1.0.0
false
`, []))
    })
  })

  context('when package is in range', () => {
    context('when bluebird is 2.9.0', () => {
      useSandbox(['bluebird@2.9.0'])
      it('should instrument the package', () => runTest('true\n', [], 'manual'))
    })
    context('when bluebird is 3.7.2', () => {
      useSandbox(['bluebird@3.7.2'])
      it('should instrument the package', () => runTest('true\n', [], 'manual'))
    })
  })

  context('when package is in range (fastify)', () => {
    context('when fastify is latest', () => {
      useSandbox(['fastify'])
      it('should instrument the package', () => runTest('true\n', [], 'manual'))
    })
    context('when fastify is latest and logging enabled', () => {
      useSandbox(['fastify'])
      useEnv({ DD_TRACE_DEBUG })
      it('should instrument the package', () =>
        runTest('Application instrumentation bootstrapping complete\ntrue\n', [], 'manual'))
    })
  })

  context('when package errors out', () => {
    useSandbox(['bluebird'])
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
            assert.ok(log.includes(`
Error during ddtrace instrumentation of application, aborting.
ReferenceError: this is a test error
    at `))
            assert.ok(log.includes('\nfalse\n'))
          }, []))
    })
  })
})
