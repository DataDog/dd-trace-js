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

const { engines, nodeMaxMajor: MAX_NODE_MAJOR } = require('../package.json')
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

  const tracerFile = arg === 'loader' && esmWorks ? 'init/trace.mjs' : 'init/trace.js'
  const instrFile = arg === 'loader' && esmWorks ? 'init/instrument.mjs' : 'init/instrument.js'

  context('preferring app-dir dd-trace', () => {
    context('when dd-trace is not in the app dir', () => {
      const NODE_OPTIONS = `--no-warnings --${arg} ${path.join(__dirname, '..', filename)}`
      useEnv({ DD_TEST_TRACER_ROOT: path.join(__dirname, '..'), NODE_OPTIONS })

      {
        const supportedRuntimeContext = currentVersionIsSupported ? context : context.skip
        supportedRuntimeContext('without DD_INJECTION_ENABLED', () => {
          it('should initialize the tracer', () => testFile(tracerFile, 'true\n', [], 'manual'))

          it('should initialize instrumentation', () => testFile(instrFile, 'true\n', [], 'manual'))

          it(`should ${esmWorks ? '' : 'not '}initialize ESM instrumentation`, () =>
            testFile('init/instrument.mjs', `${esmWorks}\n`, [], 'manual'))
        })
      }

      context('with DD_INJECTION_ENABLED', () => {
        useEnv({ DD_INJECTION_ENABLED })

        it('should not initialize the tracer', () => testFile(tracerFile, 'false\n', [], ''))

        it('should not initialize instrumentation', () => testFile(instrFile, 'false\n', [], ''))

        it('should not initialize ESM instrumentation', () => testFile('init/instrument.mjs', 'false\n', [], ''))

        {
          const loaderInternalsTest = arg === 'import' ? it : it.skip
          loaderInternalsTest('does not load loader internals after deferring to the app copy', () =>
            testFile('init/loader-hook-loaded.js', 'false\n', [], ''))
        }
      })
    })

    context('when dd-trace in the app dir', () => {
      const NODE_OPTIONS = `--no-warnings --${arg} dd-trace/${filename}`
      useEnv({ NODE_OPTIONS })

      context('without DD_INJECTION_ENABLED', () => {
        it('should initialize the tracer', () => testFile(tracerFile, 'true\n', [], 'manual'))

        it('should initialize instrumentation', () => testFile(instrFile, 'true\n', [], 'manual'))

        it(`should ${esmWorks ? '' : 'not '}initialize ESM instrumentation`, () =>
          testFile('init/instrument.mjs', `${esmWorks}\n`, [], 'manual'))
      })

      context('with DD_INJECTION_ENABLED', () => {
        useEnv({ DD_INJECTION_ENABLED, DD_TRACE_DEBUG })

        it('should initialize the tracer', () => testFile(tracerFile, 'true\n', telemetryGood, 'ssi'))

        it('should initialize instrumentation', () => testFile(instrFile, 'true\n', telemetryGood, 'ssi'))

        it(`should ${esmWorks ? '' : 'not '}initialize ESM instrumentation`, () =>
          testFile('init/instrument.mjs', `${esmWorks}\n`, telemetryGood, 'ssi'))
      })
    })
  })
}

function testRuntimeVersionChecks (arg, filename) {
  context('runtime version check', () => {
    const NODE_OPTIONS = `--${arg} dd-trace/${filename}`
    const entryFile = arg === 'loader' ? 'init/trace.mjs' : 'init/trace.js'
    const doTest = (expectedOut, expectedTelemetryPoints, expectedSource) =>
      testFile(entryFile, expectedOut, expectedTelemetryPoints, expectedSource)
    const doTestForced = async (expectedOut, expectedTelemetryPoints, expectedSource) => {
      Object.assign(process.env, { DD_INJECT_FORCE })
      try {
        await testFile(entryFile, expectedOut, expectedTelemetryPoints, expectedSource)
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

      assert.match(engines, /^>=\d+$/)
    })

    context('when node version is too old', () => {
      useEnv({ NODE_OPTIONS })

      before(() => {
        const pkg = JSON.parse(pkgStr)
        pkg.engines.node = `>=${NODE_MAJOR + 1}`
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
>=${NODE_MAJOR + 1} <${MAX_NODE_MAJOR}.
false
`, telemetryAbort))

          it('should initialize the tracer, if DD_INJECT_FORCE', () =>
            doTestForced(`Aborting application instrumentation due to incompatible_runtime.
Found incompatible runtime Node.js ${process.versions.node}, Supported runtimes: Node.js \
>=${NODE_MAJOR + 1} <${MAX_NODE_MAJOR}.
DD_INJECT_FORCE enabled, allowing unsupported runtimes and continuing.
Application instrumentation bootstrapping complete
true
`, telemetryForced))
        })
      })
    })

    context('when node version is too recent', () => {
      useEnv({ NODE_OPTIONS })

      before(() => {
        const pkg = JSON.parse(pkgStr)
        pkg.nodeMaxMajor = NODE_MAJOR
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
${engines.node} <${NODE_MAJOR}.
false
`, telemetryAbort))

          it('should initialize the tracer, if DD_INJECT_FORCE', () =>
            doTestForced(`Aborting application instrumentation due to incompatible_runtime.
Found incompatible runtime Node.js ${process.versions.node}, Supported runtimes: Node.js \
${engines.node} <${NODE_MAJOR}.
DD_INJECT_FORCE enabled, allowing unsupported runtimes and continuing.
Application instrumentation bootstrapping complete
true
`, telemetryForced))
        })
      })
    })

    {
      const supportedRuntimeContext = currentVersionIsSupported ? context : context.skip
      supportedRuntimeContext('when node version is in range of the engines field', () => {
        useEnv({ NODE_OPTIONS })

        before(() => {
          const pkg = JSON.parse(pkgStr)
          pkg.engines.node = '>=0'
          pkg.nodeMaxMajor = 1000
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

  describe('PM2 cluster mode', () => {
    useEnv({ NODE_OPTIONS: '--require dd-trace/init' })

    afterEach(() => {
      delete process.env.pm2_env
    })

    function checkEnv (expectedValues) {
      return testFile('init/pm2-env.js', out => {
        const env = JSON.parse(out.trim())
        for (const [key, value] of Object.entries(expectedValues)) {
          assert.strictEqual(env[key], value, `expected env.${key} to equal ${value}`)
        }
      }, [], '')
    }

    it('applies all env vars from pm2_env blob to process.env', () => {
      process.env.pm2_env = JSON.stringify({ DD_SERVICE: 'pm2-svc', DD_ENV: 'pm2-env', MY_APP_VAR: 'hello' })
      return checkEnv({ DD_SERVICE: 'pm2-svc', DD_ENV: 'pm2-env', MY_APP_VAR: 'hello' })
    })

    it('coerces non-string values to strings', () => {
      process.env.pm2_env = JSON.stringify({ DD_TRACE_SAMPLE_RATE: 0.5 })
      return checkEnv({ DD_TRACE_SAMPLE_RATE: '0.5' })
    })

    it('coerces null values to strings', () => {
      process.env.pm2_env = JSON.stringify({ DD_SERVICE: null })
      return checkEnv({ DD_SERVICE: 'null' })
    })

    it('does not crash on malformed pm2_env JSON', () => {
      process.env.pm2_env = 'not-valid-json'
      return checkEnv({ DD_SERVICE: undefined })
    })

    it('does nothing when pm2_env is absent', () => {
      return checkEnv({ DD_SERVICE: undefined })
    })

    describe('when env vars are already set', () => {
      useEnv({ DD_SERVICE: 'original-service', MY_APP_VAR: 'original' })

      it('overwrites existing env vars with pm2_env values', () => {
        process.env.pm2_env = JSON.stringify({ DD_SERVICE: 'pm2-service', MY_APP_VAR: 'pm2-value' })
        return checkEnv({ DD_SERVICE: 'pm2-service', MY_APP_VAR: 'pm2-value' })
      })
    })
  })
})

// ESM is not supportable prior to Node.js 14.13.1 on the 14.x line,
// or on 18.0.0 in particular.
{
  const initializeEsmSuite = semver.satisfies(process.versions.node, '>=14.13.1') ? describe : describe.skip
  initializeEsmSuite('initialize.mjs', () => {
    setShouldKill(false)
    useSandbox()
    stubTracerIfNeeded()

    context('globalPreload', () => {
      useEnv({ DD_TEST_NODE_VERSION: '20.0.0', NODE_OPTIONS: '' })

      /**
       * @param {string} out
       */
      function checkGlobalPreload (out) {
        assert.match(out,
          /^if \(getBuiltin\('module'\)\.createRequire\("file:.+\/initialize\.mjs"\)\('\.\/init\.js'\)\) {\n/)
        assert.match(out,
          /\n {2}process\.emitWarning\('dd-trace cannot instrument ES modules on Node\.js 20\.0\.0\. Upgrade to Node\.js 20\.1\.0 or newer\.'\)\n}\n$/)
      }

      it('provides application-realm preload source', () =>
        testFile('init/loader-worker.mjs', checkGlobalPreload, [], ''))
    })

    context('as --loader', () => {
      const esmWorks = process.versions.node !== '18.0.0' && process.versions.node !== '20.0.0'

      testInjectionScenarios('loader', 'initialize.mjs',
        esmWorks)
      testRuntimeVersionChecks('loader', 'initialize.mjs')

      // Only off-thread loaders install the matcher; see initialize.mjs.
      {
        const matcherContext = esmWorks && semver.satisfies(process.versions.node, '>=18.19.0') ? context : context.skip
        matcherContext('import-in-the-middle include matcher', () => {
          useEnv({
            NODE_OPTIONS: '--no-warnings --loader dd-trace/initialize.mjs',
            pm2_env: JSON.stringify({
              DD_IAST_SECURITY_CONTROLS_CONFIGURATION:
                'SANITIZER:*:init/security-control-module.mjs:sanitize',
            }),
          })

          it('wraps instrumented and PM2 security control modules and nothing else', () =>
            testFile('init/loader-matcher.mjs', 'true\n', [], ''))
        })
      }

      {
        const node20Context = process.versions.node === '20.0.0' ? context : context.skip
        node20Context('with the Node.js 20.0.0 loader', () => {
          const NODE_OPTIONS = '--no-warnings --loader dd-trace/initialize.mjs'

          context('with force', () => {
            useEnv({ DD_INJECT_FORCE, NODE_OPTIONS })

            it('initializes before a CommonJS entrypoint', () =>
              testFile('init/trace.js', 'true\n', [], ''))

            // The loader worker cannot instrument ESM here, but globalPreload still
            // initializes the tracer in the application realm before the entrypoint runs.
            it('initializes before an ESM entrypoint', () =>
              testFile('init/trace.mjs', 'true\n', [], ''))

            it('does not initialize ESM instrumentation', () =>
              testFile('init/instrument.mjs', 'false\n', [], ''))

            it('initializes inside inherited Workers', () =>
              testFile('init/loader-worker.mjs', 'true\n', [], ''))
          })
        })
      }
    })

    {
      const importContext = semver.satisfies(process.versions.node, '>=20.6.0') ? context : context.skip
      importContext('as --import', () => {
        // The loader hook is skipped on bailout, so --import children exit on their
        // own; killing them would mask a regression that keeps the process alive.
        setShouldKill(false)
        testInjectionScenarios('import', 'initialize.mjs', true)
        testRuntimeVersionChecks('import', 'initialize.mjs')
      })
    }
  })
}
