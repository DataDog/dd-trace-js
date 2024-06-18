const {
  runAndCheckWithTelemetry: testFile,
  useEnv,
  useSandbox,
  useSandboxedNode
} = require('./helpers')
const path = require('path')

const DD_INJECTION_ENABLED = 'tracing'
const DD_INJECT_FORCE = 'true'
const DD_TRACE_DEBUG = 'true'

const telemetryAbort = ['abort', 'reason:incompatible_runtime', 'abort.runtime', '']
const telemetryForced = ['complete', 'injection_forced:true']
const telemetryGood = ['complete', 'injection_forced:false']

// Node.js versions prior to 16 aren't installable with `npm install node`, but
// this is early enough to test the version check.
const oldNodeVersion = '16.20.2'

function testInjectionScenarios (arg, filename, esmWorks = false) {
  const doTest = (file, ...args) => testFile(file, ...args)
  context('preferring app-dir dd-trace', () => {
    context('when dd-trace is not in the app dir', () => {
      const NODE_OPTIONS = `--no-warnings --${arg} ${path.join(__dirname, '..', filename)}`
      useEnv({ NODE_OPTIONS })

      context('without DD_INJECTION_ENABLED', () => {
        it('should initialize the tracer', () => doTest('init/trace.js', 'true\n'))
        it('should initialize instrumentation', () => doTest('init/instrument.js', 'true\n'))
        it(`should ${esmWorks ? '' : 'not '}initialize ESM instrumentation`, () =>
          doTest('init/instrument.mjs', `${esmWorks}\n`))
      })
      context('with DD_INJECTION_ENABLED', () => {
        useEnv({ DD_INJECTION_ENABLED })

        it('should not initialize the tracer', () => doTest('init/trace.js', 'false\n'))
        it('should not initialize instrumentation', () => doTest('init/instrument.js', 'false\n'))
        it('should not initialize ESM instrumentation', () => doTest('init/instrument.mjs', 'false\n'))
      })
    })
    context('when dd-trace in the app dir', () => {
      const NODE_OPTIONS = `--no-warnings --${arg} dd-trace/${filename}`
      useEnv({ NODE_OPTIONS })

      context('without DD_INJECTION_ENABLED', () => {
        it('should initialize the tracer', () => doTest('init/trace.js', 'true\n'))
        it('should initialize instrumentation', () => doTest('init/instrument.js', 'true\n'))
        it(`should ${esmWorks ? '' : 'not '}initialize ESM instrumentation`, () =>
          doTest('init/instrument.mjs', `${esmWorks}\n`))
      })
      context('with DD_INJECTION_ENABLED', () => {
        useEnv({ DD_INJECTION_ENABLED })

        it('should initialize the tracer', () => doTest('init/trace.js', 'true\n', ...telemetryGood))
        it('should initialize instrumentation', () => doTest('init/instrument.js', 'true\n', ...telemetryGood))
        it(`should ${esmWorks ? '' : 'not '}initialize ESM instrumentation`, () =>
          doTest('init/instrument.mjs', `${esmWorks}\n`, ...telemetryGood))
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

    context('when node version is less than engines field', () => {
      useSandboxedNode()
      useEnv({ NODE_OPTIONS })

      it('should initialize the tracer, if no DD_INJECTION_ENABLED', () =>
        doTest('true\n'))
      context('with DD_INJECTION_ENABLED', () => {
        useEnv({ DD_INJECTION_ENABLED })

        context('without debug', () => {
          it('should not initialize the tracer', () => doTest('false\n', ...telemetryAbort))
          it('should initialize the tracer, if DD_INJECT_FORCE', () => doTestForced('true\n', ...telemetryForced))
        })
        context('with debug', () => {
          useEnv({ DD_TRACE_DEBUG })

          it('should not initialize the tracer', () =>
            doTest(`Aborting application instrumentation due to incompatible_runtime.
Found incompatible runtime nodejs ${oldNodeVersion}, Supported runtimes: nodejs >=18.
false
`, ...telemetryAbort))
          it('should initialize the tracer, if DD_INJECT_FORCE', () =>
            doTestForced(`Aborting application instrumentation due to incompatible_runtime.
Found incompatible runtime nodejs ${oldNodeVersion}, Supported runtimes: nodejs >=18.
DD_INJECT_FORCE enabled, allowing unsupported runtimes and continuing.
Application instrumentation bootstrapping complete
true
`, ...telemetryForced))
        })
      })
    })
    context('when node version is more than engines field', () => {
      useEnv({ NODE_OPTIONS })

      it('should initialize the tracer, if no DD_INJECTION_ENABLED', () => doTest('true\n'))
      context('with DD_INJECTION_ENABLED', () => {
        useEnv({ DD_INJECTION_ENABLED })

        context('without debug', () => {
          it('should initialize the tracer', () => doTest('true\n', ...telemetryGood))
          it('should initialize the tracer, if DD_INJECT_FORCE', () =>
            doTestForced('true\n', ...telemetryGood))
        })
        context('with debug', () => {
          useEnv({ DD_TRACE_DEBUG })

          it('should initialize the tracer', () =>
            doTest('Application instrumentation bootstrapping complete\ntrue\n', ...telemetryGood))
          it('should initialize the tracer, if DD_INJECT_FORCE', () =>
            doTestForced('Application instrumentation bootstrapping complete\ntrue\n', ...telemetryGood))
        })
      })
    })
  })
}

describe('init.js', () => {
  useSandbox([`node@${oldNodeVersion}`])

  testInjectionScenarios('require', 'init.js', false)
  testRuntimeVersionChecks('require', 'init.js')
})

describe('initialize.mjs', () => {
  useSandbox([`node@${oldNodeVersion}`])

  context('as --loader', () => {
    testInjectionScenarios('loader', 'initialize.mjs', true)
    testRuntimeVersionChecks('loader', 'initialize.mjs')
  })
  if (Number(process.versions.node.split('.')[0]) >= 18) {
    context('as --import', () => {
      testInjectionScenarios('import', 'initialize.mjs', true)
      testRuntimeVersionChecks('loader', 'initialize.mjs')
    })
  }
})
