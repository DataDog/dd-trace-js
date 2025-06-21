const semver = require('semver')
const {
  runAndCheckWithTelemetry: testFile,
  useEnv,
  useSandbox,
  sandboxCwd,
  setShouldKill
} = require('./helpers')
const path = require('path')
const fs = require('fs')

const DD_INJECTION_ENABLED = 'tracing'
const DD_INJECT_FORCE = 'true'
const DD_TRACE_DEBUG = 'true'

const telemetryAbort = ['abort', 'reason:incompatible_runtime', 'abort.runtime', '']
const telemetryForced = ['complete', 'injection_forced:true']
const telemetryGood = ['complete', 'injection_forced:false']

const { engines } = require('../package.json')
const supportedRange = engines.node
const currentVersionIsSupported = semver.satisfies(process.versions.node, supportedRange)

// These are on by default in release tests, so we'll turn them off for
// more fine-grained control of these variables in these tests.
delete process.env.DD_INJECTION_ENABLED
delete process.env.DD_INJECT_FORCE

function testInjectionScenarios (arg, filename, esmWorks = false) {
  if (!currentVersionIsSupported) return
  const doTest = (file, ...args) => testFile(file, ...args)
  context('preferring app-dir dd-trace', () => {
    context('when dd-trace is not in the app dir', () => {
      const NODE_OPTIONS = `--no-warnings --${arg} ${path.join(__dirname, '..', filename)}`
      useEnv({ NODE_OPTIONS })

      if (currentVersionIsSupported) {
        context('without DD_INJECTION_ENABLED', () => {
          it('should initialize the tracer', () => doTest('init/trace.js', 'true\n', [], 'ssi'))
          it('should initialize instrumentation', () => doTest('init/instrument.js', 'true\n', [], 'ssi'))
          it(`should ${esmWorks ? '' : 'not '}initialize ESM instrumentation`, () =>
            doTest('init/instrument.mjs', `${esmWorks}\n`, []))
        })
      }
      context('with DD_INJECTION_ENABLED', () => {
        useEnv({ DD_INJECTION_ENABLED })

        it('should not initialize the tracer', () => doTest('init/trace.js', 'false\n', []))
        it('should not initialize instrumentation', () => doTest('init/instrument.js', 'false\n', []))
        it('should not initialize ESM instrumentation', () => doTest('init/instrument.mjs', 'false\n', []))
      })
    })
    context('when dd-trace in the app dir', () => {
      const NODE_OPTIONS = `--no-warnings --${arg} dd-trace/${filename}`
      useEnv({ NODE_OPTIONS })

      context('without DD_INJECTION_ENABLED', () => {
        it('should initialize the tracer', () => doTest('init/trace.js', 'true\n', [], 'ssi'))
        it('should initialize instrumentation', () => doTest('init/instrument.js', 'true\n', [], 'ssi'))
        it(`should ${esmWorks ? '' : 'not '}initialize ESM instrumentation`, () =>
          doTest('init/instrument.mjs', `${esmWorks}\n`, []))
      })
      context('with DD_INJECTION_ENABLED', () => {
        useEnv({ DD_INJECTION_ENABLED, DD_TRACE_DEBUG })

        it('should initialize the tracer', () => doTest('init/trace.js', 'true\n', telemetryGood, 'ssi'))
        it('should initialize instrumentation', () => doTest('init/instrument.js', 'true\n', telemetryGood, 'ssi'))
        it(`should ${esmWorks ? '' : 'not '}initialize ESM instrumentation`, () =>
          doTest('init/instrument.mjs', `${esmWorks}\n`, telemetryGood, 'ssi'))
      })
    })
  })
}

function testRuntimeVersionChecks (arg, filename) {
  context('runtime version check', () => {
    const NODE_OPTIONS = `--${arg} dd-trace/${filename}`
    const doTest = (...args) => testFile('init/trace.js', ...args)
    const doTestForced = async (...args) => {
      Object.assign(process.env, { DD_INJECT_FORCE })
      try {
        await testFile('init/trace.js', ...args)
      } finally {
        delete process.env.DD_INJECT_FORCE
      }
    }

    if (!currentVersionIsSupported) {
      context('when node version is less than engines field', () => {
        useEnv({ NODE_OPTIONS })

        it('should not initialize the tracer', () =>
          doTest('false\n', []))
        context('with DD_INJECTION_ENABLED', () => {
          useEnv({ DD_INJECTION_ENABLED })

          context('without debug', () => {
            it('should not initialize the tracer', () => doTest('false\n', telemetryAbort))
            it('should initialize the tracer, if DD_INJECT_FORCE', () => doTestForced('true\n', telemetryForced))
          })
          context('with debug', () => {
            useEnv({ DD_TRACE_DEBUG })

            it('should not initialize the tracer', () =>
              doTest(`Aborting application instrumentation due to incompatible_runtime.
Found incompatible runtime nodejs ${process.versions.node}, Supported runtimes: nodejs \
>=18.
false
`, telemetryAbort))
            it('should initialize the tracer, if DD_INJECT_FORCE', () =>
              doTestForced(`Aborting application instrumentation due to incompatible_runtime.
Found incompatible runtime nodejs ${process.versions.node}, Supported runtimes: nodejs \
>=18.
DD_INJECT_FORCE enabled, allowing unsupported runtimes and continuing.
Application instrumentation bootstrapping complete
true
`, telemetryForced))
          })
        })
      })
    } else {
      context('when node version is more than engines field', () => {
        useEnv({ NODE_OPTIONS })

        it('should initialize the tracer, if no DD_INJECTION_ENABLED', () => doTest('true\n', [], 'ssi'))
        context('with DD_INJECTION_ENABLED', () => {
          useEnv({ DD_INJECTION_ENABLED })

          context('without debug', () => {
            it('should initialize the tracer', () => doTest('true\n', telemetryGood, 'ssi'))
            it('should initialize the tracer, if DD_INJECT_FORCE', () =>
              doTestForced('true\n', telemetryGood, 'ssi'))
          })
          context('with debug', () => {
            useEnv({ DD_TRACE_DEBUG })

            it('should initialize the tracer', () =>
              doTest('Application instrumentation bootstrapping complete\ntrue\n', telemetryGood, 'ssi'))
            it('should initialize the tracer, if DD_INJECT_FORCE', () =>
              doTestForced('Application instrumentation bootstrapping complete\ntrue\n', telemetryGood, 'ssi'))
          })
        })
      })
    }
  })
}

function stubTracerIfNeeded () {
  if (!currentVersionIsSupported) {
    before(() => {
      // Stub out the tracer in the sandbox, since it will not likely load properly.
      // We're only doing this on versions we don't support, since the forcing
      // action results in undefined behavior in the tracer.
      fs.writeFileSync(
        path.join(sandboxCwd(), 'node_modules/dd-trace/index.js'),
        'exports.init = () => { Object.assign(global, { _ddtrace: true }) }'
      )
    })
  }
}

describe('init.js', () => {
  setShouldKill(false)
  useSandbox()
  stubTracerIfNeeded()

  testInjectionScenarios('require', 'init.js', false)
  testRuntimeVersionChecks('require', 'init.js')
})

// ESM is not supportable prior to Node.js 14.13.1 on the 14.x line,
// or on 18.0.0 in particular.
if (semver.satisfies(process.versions.node, '>=14.13.1')) {
  describe('initialize.mjs', () => {
    setShouldKill(false)
    useSandbox()
    stubTracerIfNeeded()

    context('as --loader', () => {
      testInjectionScenarios('loader', 'initialize.mjs',
        process.versions.node !== '18.0.0')
      testRuntimeVersionChecks('loader', 'initialize.mjs')
    })
    if (semver.satisfies(process.versions.node, '>=20.6.0')) {
      context('as --import', () => {
        testInjectionScenarios('import', 'initialize.mjs', true)
        testRuntimeVersionChecks('loader', 'initialize.mjs')
      })
    }
  })
}
