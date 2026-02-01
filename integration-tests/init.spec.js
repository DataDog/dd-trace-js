'use strict'

const assert = require('assert')
const path = require('path')
const fs = require('fs')
const semver = require('semver')

const DD_INJECTION_ENABLED = 'tracing'
const DD_INJECT_FORCE = 'true'
const DD_TRACE_DEBUG = 'true'
const { NODE_MAJOR, NODE_VERSION } = require('../version')

const telemetryAbort = ['abort', 'reason:incompatible_runtime', 'abort.runtime', '']
const telemetryForced = ['complete', 'injection_forced:true']
const telemetryGood = ['complete', 'injection_forced:false']

const { engines } = require('../package.json')
const {
  runAndCheckWithTelemetry: testFile,
  useEnv,
  useSandbox,
  sandboxCwd,
  setShouldKill,
} = require('./helpers')
const supportedRange = engines.node
const currentVersionIsSupported = semver.satisfies(NODE_VERSION, supportedRange)
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
          it('should initialize the tracer', () => doTest('init/trace.js', 'true\n', [], 'manual'))

          it('should initialize instrumentation', () => doTest('init/instrument.js', 'true\n', [], 'manual'))

          it(`should ${esmWorks ? '' : 'not '}initialize ESM instrumentation`, () =>
            doTest('init/instrument.mjs', `${esmWorks}\n`, [], 'manual'))
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
        it('should initialize the tracer', () => doTest('init/trace.js', 'true\n', [], 'manual'))

        it('should initialize instrumentation', () => doTest('init/instrument.js', 'true\n', [], 'manual'))

        it(`should ${esmWorks ? '' : 'not '}initialize ESM instrumentation`, () =>
          doTest('init/instrument.mjs', `${esmWorks}\n`, [], 'manual'))
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

    let pkgPath
    let pkgStr

    before(() => {
      pkgPath = `${sandboxCwd()}/node_modules/dd-trace/package.json`
      pkgStr = fs.readFileSync(pkgPath, 'utf8')
    })

    after(() => {
      fs.writeFileSync(pkgPath, pkgStr)
    })

    it('should be able to use the engines field', () => {
      const engines = require(`${sandboxCwd()}/node_modules/dd-trace/package.json`).engines.node

      assert.match(engines, /^>=\d+ <\d+$/)
    })

    context('when node version is too recent', () => {
      useEnv({ NODE_OPTIONS })

      before(() => {
        const pkg = JSON.parse(pkgStr)
        pkg.engines.node = `>=${NODE_MAJOR - 1} <${NODE_MAJOR}`
        fs.writeFileSync(pkgPath, JSON.stringify(pkg))
      })

      it('should not initialize the tracer', () => doTest('false\n', []))

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
Found incompatible runtime Node.js ${process.versions.node}, Supported runtimes: Node.js \
>=${NODE_MAJOR - 1} <${NODE_MAJOR}.
false
`, telemetryAbort))

          it('should initialize the tracer, if DD_INJECT_FORCE', () =>
            doTestForced(`Aborting application instrumentation due to incompatible_runtime.
Found incompatible runtime Node.js ${process.versions.node}, Supported runtimes: Node.js \
>=${NODE_MAJOR - 1} <${NODE_MAJOR}.
DD_INJECT_FORCE enabled, allowing unsupported runtimes and continuing.
Application instrumentation bootstrapping complete
true
`, telemetryForced))
        })
      })
    })

    context('when node version is too old', () => {
      useEnv({ NODE_OPTIONS })

      before(() => {
        const pkg = JSON.parse(pkgStr)
        pkg.engines.node = `>=${NODE_MAJOR + 1} <${NODE_MAJOR + 2}`
        fs.writeFileSync(pkgPath, JSON.stringify(pkg))
      })

      it('should not initialize the tracer', () => doTest('false\n', []))

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
Found incompatible runtime Node.js ${process.versions.node}, Supported runtimes: Node.js \
>=${NODE_MAJOR + 1} <${NODE_MAJOR + 2}.
false
`, telemetryAbort))

          it('should initialize the tracer, if DD_INJECT_FORCE', () =>
            doTestForced(`Aborting application instrumentation due to incompatible_runtime.
Found incompatible runtime Node.js ${process.versions.node}, Supported runtimes: Node.js \
>=${NODE_MAJOR + 1} <${NODE_MAJOR + 2}.
DD_INJECT_FORCE enabled, allowing unsupported runtimes and continuing.
Application instrumentation bootstrapping complete
true
`, telemetryForced))
        })
      })
    })

    if (currentVersionIsSupported) {
      context('when node version is in range of the engines field', () => {
        useEnv({ NODE_OPTIONS })

        before(() => {
          const pkg = JSON.parse(pkgStr)
          pkg.engines.node = '>=0 <1000'
          fs.writeFileSync(pkgPath, JSON.stringify(pkg))
        })

        it('should initialize the tracer, if no DD_INJECTION_ENABLED', () => doTest('true\n', [], 'manual'))

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
