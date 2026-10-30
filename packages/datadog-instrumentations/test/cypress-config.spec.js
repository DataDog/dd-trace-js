'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { createContext, runInContext } = require('node:vm')

const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru().noPreserveCache()

const log = require('../../dd-trace/src/log')
const observeRetryConfig = require('../../datadog-plugin-cypress/src/retry-config-observer')
const {
  installManualSupportFile,
  installSupportFile,
  wrapCliConfigFileOptions,
  wrapConfig,
} = require('../src/cypress-config')

describe('Cypress before:run handlers', () => {
  const setupChannel = channel('ci:cypress:setup-node-events')
  let project, resolved, handlers, register, cleanup

  beforeEach(() => {
    project = fs.mkdtempSync(join(tmpdir(), 'dd-cypress-before-run-'))
    resolved = { projectRoot: project, supportFile: false, isInteractive: false }
    handlers = {}
    register = cleanup = undefined
  })

  afterEach(async () => {
    if (register) setupChannel.unsubscribe(register)
    resolved.isInteractive = false
    try {
      if (cleanup) cleanup()
      else await handlers['after:run']?.({})
    } finally {
      fs.rmSync(project, { recursive: true, force: true })
    }
  })

  /**
   * Register the same hooks through the automatic or manual plugin entry point.
   * @param {string} mode
   * @param {(details: object) => unknown} first
   * @param {(details: object) => unknown} datadog
   * @param {(details: object) => unknown} [last]
   */
  function setupHandlers (mode, first, datadog, last = () => {}) {
    if (mode === 'auto') {
      register = payload => {
        payload.registerBeforeRun(datadog)
        payload.on('after:run', payload.cleanupWrapper)
        cleanup = payload.cleanupWrapper
        payload.registered = true
      }
      setupChannel.subscribe(register)
    }
    const config = wrapConfig({
      e2e: {
        setupNodeEvents (on) {
          on('before:run', first)
          if (mode === 'manual') {
            on('before:run', datadog)
            on('after:spec', () => {})
            on('after:run', () => {})
            on('task', {
              'dd:testSuiteStart': () => {},
              'dd:beforeEach': () => {},
              'dd:afterEach': () => {},
              'dd:addTags': () => {},
            })
          }
          on('before:run', last)
        },
      },
    })
    config.e2e.setupNodeEvents((event, handler) => { handlers[event] = handler }, resolved)
  }

  it('preserves user handlers when Datadog instrumentation is inactive', async () => {
    const calls = []
    const details = { cypressVersion: '14.5.4' }
    const datadog = sinon.spy()
    setupHandlers('disabled', async runDetails => {
      await Promise.resolve()
      calls.push(['first', runDetails])
    }, datadog, runDetails => calls.push(['second', runDetails]))

    await handlers['before:run'](details)

    assert.deepStrictEqual(calls, [['first', details], ['second', details]])
    sinon.assert.notCalled(datadog)
  })

  for (const mode of ['auto', 'manual']) {
    it(`does not call later handlers after the first user handler rejects (${mode})`, async () => {
      const rejection = new Error('before-run rejected')
      const first = sinon.stub().rejects(rejection)
      const datadog = sinon.spy()
      const last = sinon.spy()
      const details = { cypressVersion: '14.5.4' }
      setupHandlers(mode, first, datadog, last)

      await assert.rejects(handlers['before:run'](details), error => error === rejection)

      sinon.assert.calledOnceWithExactly(first, details)
      sinon.assert.notCalled(last)
      sinon.assert.notCalled(datadog)
    })

    for (const isInteractive of [false, true]) {
      for (const failingHandler of ['user', 'datadog']) {
        it(`retains interactive support after setup fails (${mode}, interactive=${isInteractive}, ${failingHandler})`,
          async () => {
            const rejection = new Error('before-run rejected')
            let shouldFail = true
            const datadogHandler = sinon.spy(() => {
              if (shouldFail && failingHandler === 'datadog') throw rejection
            })
            resolved.isInteractive = isInteractive
            setupHandlers(mode, () => {
              if (shouldFail && failingHandler === 'user') throw rejection
            }, datadogHandler)

            assert.ok(fs.existsSync(resolved.supportFile))
            await assert.rejects(handlers['before:run']({}), error => error === rejection)
            assert.strictEqual(fs.existsSync(resolved.supportFile), isInteractive)
            if (isInteractive) {
              shouldFail = false
              datadogHandler.resetHistory()
              await handlers['before:run']({})
              sinon.assert.calledOnce(datadogHandler)
              await handlers['after:run']({})
              assert.ok(fs.existsSync(resolved.supportFile))
            }
          })
      }
    }
  }
})

describe('Cypress returned retry getters', () => {
  for (const asynchronous of [false, true]) {
    it(`uses the once-materialized retry value at IPC (async=${asynchronous})`, async () => {
      const project = fs.mkdtempSync(join(tmpdir(), 'dd-cypress-returned-getter-'))
      const descriptor = Object.getOwnPropertyDescriptor(process, 'send')
      const changes = []
      const sent = []
      process.send = message => sent.push(JSON.parse(JSON.stringify(message)))
      const resolved = { projectRoot: project, supportFile: false, retries: 0 }
      const observer = observeRetryConfig(resolved, retries => changes.push(retries))
      const handlers = {}
      let reads = 0
      const returned = { get retries () { return ++reads } }
      const wrapped = wrapConfig({
        e2e: {
          setupNodeEvents: () => asynchronous ? Promise.resolve(returned) : returned,
        },
      })
      try {
        const result = await wrapped.e2e.setupNodeEvents((event, handler) => { handlers[event] = handler }, resolved)
        process.send({ event: 'setupTestingType:reply', args: [{ setupConfig: result }] })
        assert.strictEqual(reads, 1)
        assert.deepStrictEqual(changes, [1])
        assert.strictEqual(sent[0].args[0].setupConfig.retries, 1)
      } finally {
        observer.stop()
        if (descriptor) Object.defineProperty(process, 'send', descriptor)
        else delete process.send
        await handlers['after:run']?.({})
        fs.rmSync(project, { recursive: true, force: true })
      }
    })
  }
})

describe('Cypress config', () => {
  for (const testingType of ['e2e', 'component']) {
    for (const hasSubscriber of [false, true]) {
      it(`accepts browser teardown declarations when instrumentation is inactive (${testingType}, ` +
        `subscriber=${hasSubscriber})`, async () => {
        const project = fs.mkdtempSync(join(tmpdir(), 'dd-cypress-noop-'))
        const setupChannel = channel('ci:cypress:setup-node-events')
        const inactiveSubscriber = () => {}
        const handlers = {}
        const resolved = { projectRoot: project, supportFile: false, isInteractive: false }
        if (hasSubscriber) setupChannel.subscribe(inactiveSubscriber)
        try {
          const config = wrapConfig({ [testingType]: {} })
          config[testingType].setupNodeEvents((event, handler) => { handlers[event] = handler }, resolved)

          const tasks = handlers.task
          assert.strictEqual(tasks['dd:testSuiteStart']({ testSuite: 'passing.cy.js' }), null)
          assert.strictEqual(tasks['dd:testDeclarations']({
            testSuite: 'passing.cy.js',
            testAnnotations: [{ title: 'passes', noAutoRetry: true }],
          }), null)
        } finally {
          if (hasSubscriber) setupChannel.unsubscribe(inactiveSubscriber)
          await handlers['after:run']?.({})
          fs.rmSync(project, { recursive: true, force: true })
        }
      })
    }
  }

  it('loads and wraps an ESM config', async () => {
    const project = fs.mkdtempSync(join(tmpdir(), 'dd-cypress-config-'))
    const configFile = join(project, 'cypress.config.mjs')
    fs.writeFileSync(configFile, `
      const setupNodeEvents = () => {}
      export default {
        marker: 'esm',
        e2e: { setupNodeEvents, originalSetupNodeEvents: setupNodeEvents },
      }
    `)

    const wrapped = wrapCliConfigFileOptions({ project, configFile })
    try {
      const { default: config } = await import(pathToFileURL(wrapped.options.configFile))

      assert.strictEqual(config.marker, 'esm')
      assert.notStrictEqual(config.e2e.setupNodeEvents, config.e2e.originalSetupNodeEvents)
      assert.strictEqual(config.e2e.setupNodeEvents.name, 'ddSetupNodeEvents')
    } finally {
      wrapped.cleanup()
      fs.rmSync(project, { recursive: true, force: true })
    }
  })

  it('loads and wraps a CommonJS config', () => {
    const project = fs.mkdtempSync(join(tmpdir(), 'dd-cypress-config-'))
    const configFile = join(project, 'cypress.config.cjs')
    fs.writeFileSync(configFile, `
      const setupNodeEvents = () => {}
      module.exports = {
        marker: 'commonjs',
        e2e: { setupNodeEvents, originalSetupNodeEvents: setupNodeEvents },
      }
    `)

    const wrapped = wrapCliConfigFileOptions({ project, configFile })
    try {
      const config = require(wrapped.options.configFile)

      assert.strictEqual(config.marker, 'commonjs')
      assert.notStrictEqual(config.e2e.setupNodeEvents, config.e2e.originalSetupNodeEvents)
      assert.strictEqual(config.e2e.setupNodeEvents.name, 'ddSetupNodeEvents')
    } finally {
      wrapped.cleanup()
      fs.rmSync(project, { recursive: true, force: true })
    }
  })

  it('reports every failed config-wrapper location', () => {
    const project = fs.mkdtempSync(join(tmpdir(), 'dd-cypress-config-'))
    const configDirectory = join(project, 'config')
    const configFile = join(configDirectory, 'cypress.config.cjs')
    const options = { project, configFile }
    fs.mkdirSync(configDirectory)
    fs.writeFileSync(configFile, 'module.exports = {}')
    const warn = sinon.stub(log, 'warn')
    const openSync = sinon.stub(fs, 'openSync').throws()

    try {
      const wrapped = wrapCliConfigFileOptions(options)

      assert.strictEqual(wrapped.options, options)
      assert.match(warn.firstCall.args[2], /; /)
    } finally {
      openSync.restore()
      warn.restore()
      fs.rmSync(project, { recursive: true, force: true })
    }
  })
})

describe('Cypress support initialization ownership', () => {
  for (const manualFirst of [false, true]) {
    it(`loads support once per Mocha root across automatic and manual entries (manual first=${manualFirst})`, () => {
      const project = fs.mkdtempSync(join(tmpdir(), 'dd-cypress-support-owner-'))
      const originalSupport = join(project, 'support.js')
      const manualSource = fs.readFileSync(join(__dirname, '../../../ci/cypress/support.js'), 'utf8')
      const browserSupport = require.resolve('../../datadog-plugin-cypress/src/support')
      const originalRead = fs.readFileSync
      fs.writeFileSync(originalSupport, "require('dd-trace/ci/cypress/support')\n")
      const read = sinon.stub(fs, 'readFileSync').callsFake((filename, ...args) => {
        return filename === browserSupport ? 'globalThis.installations++' : originalRead(filename, ...args)
      })
      try {
        const config = { projectRoot: project, supportFile: originalSupport }
        const files = installSupportFile(config)
        assert.strictEqual(files.length, 2)
        assert.notStrictEqual(config.supportFile, originalSupport)
        assert.strictEqual(installSupportFile(config), undefined)
        assert.strictEqual(fs.readdirSync(project).length, 3)
        const generatedSource = fs.readFileSync(files[0], 'utf8')
        let root = {}
        const context = createContext({
          Cypress: { mocha: { getRootSuite: () => root } },
          installations: 0,
          require: () => { context.installations++ },
        })
        const automatic = () => runInContext(`(function () {${generatedSource}\n})()`, context)
        const manual = () => runInContext(`(function () {${manualSource}\n})()`, context)
        for (let run = 1; run <= 2; run++) {
          root = {}
          for (const entry of manualFirst ? [manual, automatic, manual] : [automatic, manual, automatic]) entry()
          assert.strictEqual(context.installations, run)
        }
        assert.strictEqual(fs.readFileSync(originalSupport, 'utf8'), "require('dd-trace/ci/cypress/support')\n")
      } finally {
        read.restore()
        fs.rmSync(project, { recursive: true, force: true })
      }
    })
  }

  for (const { version, preload } of [
    { version: '6.7.0', preload: false },
    { version: '10.2.0', preload: false },
    { version: '12.0.0', preload: true },
    { version: '16.2.0', preload: true },
  ]) {
    it(`preloads manual support only with the required Cypress capability (${version})`, () => {
      const install = sinon.spy()
      const config = { version }
      const plugin = proxyquire('../../datadog-plugin-cypress/src/plugin', {
        '../../../version': { DD_MAJOR: 5 },
        '../../dd-trace': { _tracer: {} },
        '../../datadog-instrumentations/src/cypress-config': { installManualSupportFile: install },
        './cypress-plugin': {
          beforeRun () {},
          afterSpec () {},
          afterRun () {},
          getAfterScreenshotHandler () {},
          getTasks () { return {} },
          init (_tracer, resolved) { return resolved },
        },
      })
      assert.strictEqual(plugin(() => {}, config), config)
      assert.strictEqual(install.callCount, Number(preload))
      if (install.called) sinon.assert.calledWithExactly(install, config)
    })
  }
})

describe('Cypress manual setup reply ownership', () => {
  for (const alternate of [false, true]) {
    it(`preserves a frozen partial setup reply and native send arguments (alternate=${alternate})`, () => {
      const project = fs.mkdtempSync(join(tmpdir(), 'dd-cypress-support-reply-'))
      const originalSupport = join(project, 'support.js')
      const alternateSupport = join(project, 'alternate.js')
      fs.writeFileSync(originalSupport, '')
      fs.writeFileSync(alternateSupport, '')
      const descriptor = Object.getOwnPropertyDescriptor(process, 'send')
      const returned = {}
      const originalSend = sinon.spy(function () { return returned })
      process.send = originalSend
      let stop
      try {
        const config = { projectRoot: project, supportFile: originalSupport }
        stop = installManualSupportFile(config)
        const supportOwner = Symbol.for('dd-trace.cypress.support-owner')
        assert.deepStrictEqual(config[supportOwner], { path: config.supportFile, deferLifecycle: true })
        const supportSend = process.send
        let observed
        const outer = function (message) {
          observed = message.args[0].setupConfig
          return supportSend.apply(this, arguments)
        }
        process.send = outer
        let supportReads = 0
        const supplied = { retries: Object.freeze({ openMode: 0 }) }
        if (alternate) {
          Object.defineProperty(supplied, 'supportFile', {
            enumerable: true,
            get () { supportReads++; return 'alternate.js' },
          })
        }
        Object.freeze(supplied)
        JSON.stringify(supplied)
        assert.strictEqual(supportReads, Number(alternate))
        supportReads = 0
        const reply = Object.freeze({ setupConfig: supplied, registrations: [] })
        const message = Object.freeze({ event: 'setupTestingType:reply', args: Object.freeze([reply]), marker: 'keep' })
        const receiver = {}
        const handle = {}
        const options = {}
        const callback = () => {}
        assert.strictEqual(process.send.call(receiver, message, handle, options, callback), returned)
        assert.strictEqual(observed, supplied)
        assert.strictEqual(supportReads, Number(alternate))
        const sent = originalSend.firstCall.args[0]
        assert.notStrictEqual(sent, message)
        assert.strictEqual(sent.marker, 'keep')
        assert.strictEqual(sent.args[0].registrations, reply.registrations)
        assert.strictEqual(sent.args[0].setupConfig.retries, supplied.retries)
        assert.strictEqual(originalSend.firstCall.thisValue, receiver)
        assert.deepStrictEqual(originalSend.firstCall.args.slice(1), [handle, options, callback])
        const installedSupport = sent.args[0].setupConfig.supportFile
        assert.deepStrictEqual(sent.args[0].setupConfig[supportOwner],
          { path: installedSupport, deferLifecycle: true })
        assert.ok(fs.existsSync(installedSupport))
        if (alternate) assert.match(fs.readFileSync(installedSupport, 'utf8'), /alternate\.js/)
        else assert.strictEqual(installedSupport, config.supportFile)
        assert.strictEqual(supplied.supportFile, alternate ? 'alternate.js' : undefined)
        assert.strictEqual(process.send, outer)
        process.send(message)
        assert.strictEqual(originalSend.lastCall.args[0], message)
      } finally {
        stop?.()
        if (descriptor) Object.defineProperty(process, 'send', descriptor)
        else delete process.send
        fs.rmSync(project, { recursive: true, force: true })
      }
    })
  }

  it('forwards setup errors unchanged and restores only its own send wrapper', () => {
    const project = fs.mkdtempSync(join(tmpdir(), 'dd-cypress-support-error-'))
    const descriptor = Object.getOwnPropertyDescriptor(process, 'send')
    const originalSend = sinon.spy()
    process.send = originalSend
    let stop
    try {
      stop = installManualSupportFile({ projectRoot: project, supportFile: false })
      const message = Object.freeze({ event: 'setupTestingType:error', args: Object.freeze(['setup failed']) })
      process.send(message)
      sinon.assert.calledOnceWithExactly(originalSend, message)
      assert.strictEqual(process.send, originalSend)
    } finally {
      stop?.()
      if (descriptor) Object.defineProperty(process, 'send', descriptor)
      else delete process.send
      fs.rmSync(project, { recursive: true, force: true })
    }
  })
})

describe('Cypress sealed retry configuration ownership', () => {
  for (const lock of ['seal', 'freeze']) {
    it(`stops observing a configuration after Object.${lock} without changing nested native writes`, () => {
      const config = { retries: { runMode: 2, openMode: 0 } }
      const changed = sinon.spy()
      const observer = observeRetryConfig(config, changed)
      Object[lock](config)
      observer.stop()
      sinon.assert.calledOnce(changed)
      changed.resetHistory()
      assert.strictEqual(observer.isWatching(config), false)
      config.retries.runMode = 3
      sinon.assert.notCalled(changed)
      assert.deepStrictEqual(JSON.parse(JSON.stringify(config)), { retries: { runMode: 3, openMode: 0 } })
      observer.stop()
    })
  }
})

describe('Cypress observer and lifecycle phases', () => {
  for (const mode of ['automatic', 'manual', 'conditional', 'indirect-manual', 'manual-fallback', 'manual-upgrade']) {
    it(`preserves lifecycle registration order for ${mode} support`, () => {
      const project = fs.mkdtempSync(join(tmpdir(), 'dd-cypress-support-phase-'))
      const support = join(project, 'support.js')
      const explicitManual = mode === 'indirect-manual' || mode === 'manual-fallback' || mode === 'manual-upgrade'
      fs.writeFileSync(support, mode === 'automatic' || explicitManual
        ? '// user support\n'
        : `${mode === 'conditional' ? 'if (false) ' : ''}require('dd-trace/ci/cypress/support')\n`)
      const publicSource = fs.readFileSync(join(__dirname, '../../../ci/cypress/support.js'), 'utf8')
      const hooksPath = require.resolve('../../datadog-plugin-cypress/src/support')
      const raw = `globalThis.calls.push('observer')
let active = false
const root = Cypress.mocha.getRootSuite()
root[Symbol.for('dd-trace.cypress.install-lifecycle')] = () => {
  if (active) return
  active = true
  globalThis.calls.push('lifecycle')
}
if (!root[Symbol.for('dd-trace.cypress.defer-lifecycle')]) root[Symbol.for('dd-trace.cypress.install-lifecycle')]()
`
      const originalRead = fs.readFileSync
      const read = sinon.stub(fs, 'readFileSync').callsFake((filename, ...args) => {
        return filename === hooksPath ? raw : originalRead(filename, ...args)
      })
      try {
        const config = { projectRoot: project, supportFile: support }
        if (mode === 'manual-upgrade') installSupportFile(config)
        const files = installSupportFile(config, explicitManual)
        const root = {}
        const context = createContext({ Cypress: { mocha: { getRootSuite: () => root } }, calls: [], require () {} })
        const execute = source => runInContext(`(function () {${source}\n})()`, context)
        execute(fs.readFileSync(files[0], 'utf8'))
        context.calls.push('user before')
        if (mode === 'manual' || mode === 'indirect-manual' || mode === 'manual-upgrade') execute(publicSource)
        context.calls.push('user after')
        const finalizer = fs.readFileSync(files[1], 'utf8').split('\n')
          .filter(line => !line.startsWith('import ')).join('\n')
        execute(finalizer)
        const expected = mode === 'automatic'
          ? ['observer', 'lifecycle', 'user before', 'user after']
          : mode === 'manual' || mode === 'indirect-manual' || mode === 'manual-upgrade'
            ? ['observer', 'user before', 'lifecycle', 'user after']
            : ['observer', 'user before', 'user after', 'lifecycle']
        assert.deepStrictEqual(Array.from(context.calls), expected)
        execute(finalizer)
        assert.deepStrictEqual(Array.from(context.calls), expected)
      } finally {
        read.restore()
        fs.rmSync(project, { recursive: true, force: true })
      }
    })
  }
})

describe('Cypress getter-only retry roots', () => {
  for (const phase of ['before', 'during']) {
    for (const atrEnabled of [false, true]) {
      it(`preserves getter-only retries ${phase} initialization (ATR=${atrEnabled})`, async () => {
        const CypressPlugin = require('../../datadog-plugin-cypress/src/cypress-plugin').constructor
        const plugin = new CypressPlugin()
        const native = { runMode: 2, openMode: 0 }
        const config = { retries: native, version: '16.2.0' }
        const getter = () => native
        const lock = () => Object.defineProperty(config, 'retries', {
          enumerable: true, configurable: false, get: getter,
        })
        const tracer = {
          _tracer: {
            _config: { isServiceUserProvided: false },
            _exporter: {
              getLibraryConfiguration: (_config, callback) => callback(null, {
                isFlakyTestRetriesEnabled: atrEnabled, flakyTestRetriesCount: 4,
              }),
            },
          },
        }
        try {
          if (phase === 'before') lock()
          const pending = plugin.init(tracer, config)
          if (phase === 'during') lock()
          const result = await pending
          assert.notStrictEqual(result, config)
          assert.strictEqual(config.retries, native)
          const descriptor = Object.getOwnPropertyDescriptor(config, 'retries')
          assert.strictEqual(descriptor.get, getter)
          assert.strictEqual(descriptor.set, undefined)
          assert.strictEqual(descriptor.configurable, false)
          assert.deepStrictEqual(native, { runMode: 2, openMode: 0 })
          assert.deepStrictEqual(plugin.originalCypressRetries, native)
          assert.deepStrictEqual(JSON.parse(JSON.stringify(result.retries)),
            { runMode: atrEnabled ? 4 : 2, openMode: 0 })
        } finally {
          plugin.retryConfigObserver?.stop()
        }
      })
    }
  }
})

describe('Cypress saved experimental options', () => {
  for (const define of [false, true]) {
    for (const detachedRetryCount of [undefined, 3, 4, 'flags-raw-roundtrip']) {
      it(`retains saved options provenance (define=${define}, detached=${detachedRetryCount})`, async () => {
        const CypressPlugin = require('../../datadog-plugin-cypress/src/cypress-plugin').constructor
        const plugin = new CypressPlugin()
        const config = {
          version: '16.2.0',
          retries: {
            runMode: true,
            openMode: false,
            experimentalStrategy: 'detect-flake-but-always-fail',
            experimentalOptions: { maxRetries: 2, stopIfAnyPassed: false },
          },
        }
        const tracer = {
          _tracer: {
            _config: { isServiceUserProvided: false },
            _exporter: {
              getLibraryConfiguration: (_config, callback) => callback(null, {
                isFlakyTestRetriesEnabled: true, flakyTestRetriesCount: 4,
              }),
            },
          },
        }
        try {
          const result = await plugin.init(tracer, config)
          const saved = result.retries.experimentalOptions
          const raw = Object.getOwnPropertyDescriptor(result.retries, 'experimentalOptions').value
          assert.strictEqual(saved.maxRetries, 4)
          result.retries.experimentalOptions = { maxRetries: 1, stopIfAnyPassed: false }
          if (detachedRetryCount === 'flags-raw-roundtrip') {
            raw.maxRetries = 3
            Object.defineProperty(saved, 'stopIfAnyPassed', { configurable: false })
            raw.maxRetries = 4
          } else if (detachedRetryCount !== undefined) saved.maxRetries = detachedRetryCount
          assert.strictEqual(plugin.originalCypressRetries.experimentalOptions.maxRetries, 1)
          if (define) {
            Object.defineProperty(result.retries, 'experimentalOptions', { value: saved })
          } else {
            result.retries.experimentalOptions = saved
          }
          assert.strictEqual(result.retries.experimentalOptions, saved)
          assert.strictEqual(plugin.originalCypressRetries.experimentalOptions.maxRetries,
            detachedRetryCount === 'flags-raw-roundtrip' ? 4 : detachedRetryCount ?? 2)
        } finally {
          plugin.retryConfigObserver?.stop()
        }
      })
    }
  }
})

describe('Cypress native final status after late hooks', () => {
  for (const scenario of [
    { name: 'late hook', state: 'passed', attempts: ['failed'], hook: true, final: 'fail' },
    { name: 'native aggregate failure', state: 'failed', attempts: ['failed', 'passed'], final: 'fail' },
    { name: 'native aggregate pass', state: 'passed', attempts: ['passed', 'failed'], final: 'pass' },
    { name: 'ordinary pass', state: 'passed', attempts: ['passed'], final: 'pass' },
  ]) {
    it(`keeps duplicate declarations independent (${scenario.name})`, async () => {
      const CypressPlugin = require('../../datadog-plugin-cypress/src/cypress-plugin').constructor
      const plugin = new CypressPlugin()
      const createSpan = status => {
        const tags = { 'test.status': status }
        return {
          tags,
          context: () => ({
            getTag: key => tags[key],
            getTags: () => tags,
            toTraceId: () => '123',
            toSpanId: () => '456',
          }),
          setTag: (key, value) => { tags[key] = value },
          finish: sinon.spy(),
        }
      }
      const first = createSpan('pass')
      const attempts = scenario.attempts.map(state => createSpan(state === 'passed' ? 'pass' : 'fail'))
      const spec = { relative: 'duplicate-late-hook.cy.js' }
      const title = ['duplicate title']
      plugin.testSuiteSpan = createSpan('pass')
      plugin.ciVisEvent = () => {}
      plugin.getTestCodeOwners = () => undefined
      plugin.finishedTestsByFile[spec.relative] = [
        { testId: 'first', testName: title[0], testStatus: 'pass', testSpan: first, finishTime: 1 },
        ...attempts.map((testSpan, index) => ({
          testId: 'second',
          testName: title[0],
          testStatus: scenario.hook ? 'pass' : testSpan.tags['test.status'],
          testSpan,
          finishTime: index + 2,
          hasNativeRetries: attempts.length > 1,
        })),
      ]
      await plugin.afterSpec(spec, {
        stats: { tests: 2, failures: scenario.final === 'fail' ? 1 : 0 },
        tests: [
          { title, state: 'passed', attempts: [{ state: 'passed' }] },
          {
            title,
            state: scenario.state,
            attempts: scenario.attempts.map(state => ({ state })),
            ...(scenario.hook && { displayError: 'after all hook failed' }),
          },
        ],
      })
      assert.strictEqual(first.tags['test.status'], 'pass')
      assert.strictEqual(first.tags['test.final_status'], 'pass')
      assert.strictEqual(attempts.at(-1).tags['test.status'],
        scenario.attempts.at(-1) === 'passed' ? 'pass' : 'fail')
      assert.strictEqual(attempts.at(-1).tags['test.final_status'], scenario.final)
      sinon.assert.calledOnce(first.finish)
      for (const attempt of attempts) sinon.assert.calledOnce(attempt.finish)
    })
  }
})

describe('Cypress initialization and setup handoff ordering', () => {
  for (const phase of ['pending', 'resolved']) {
    for (const getter of [false, true]) {
      it(`keeps serialized retry intent after early setup handoff (${phase}, getter=${getter})`, async () => {
        const CypressPlugin = require('../../datadog-plugin-cypress/src/cypress-plugin').constructor
        const plugin = new CypressPlugin()
        const original = Object.getOwnPropertyDescriptor(process, 'send')
        let wire
        process.send = message => { wire = JSON.parse(JSON.stringify(message)).args[0].setupConfig }
        let finishSettings
        const tracer = {
          _tracer: {
            _config: { isServiceUserProvided: false },
            _exporter: { getLibraryConfiguration: (_config, callback) => { finishSettings = callback } },
          },
        }
        const config = { version: '16.2.0', retries: { runMode: 4, openMode: 0 } }
        try {
          const pending = plugin.init(tracer, config)
          let reads = 0
          const supplied = getter ? { get retries () { return ++reads } } : config
          process.send({ event: 'setupTestingType:reply', args: [{ setupConfig: supplied }] })
          if (phase === 'pending') config.retries.runMode = 2
          finishSettings(null, { isFlakyTestRetriesEnabled: true, flakyTestRetriesCount: 4 })
          const result = await pending
          if (phase === 'resolved') result.retries.runMode = 2
          assert.deepStrictEqual(wire.retries, getter ? 1 : { runMode: 4, openMode: 0 })
          assert.strictEqual(reads, Number(getter))
          plugin.retryConfigObserver?.stop()
          assert.deepStrictEqual(plugin.originalCypressRetries, getter ? 1 : { runMode: 4, openMode: 0 })
          assert.deepStrictEqual(plugin.configuredCypressRetries, { runMode: 4, openMode: getter ? 1 : 0 })
          assert.ok(!plugin.retryConfigObserver?.isWatching(plugin.cypressConfig))
        } finally {
          plugin.retryConfigObserver?.stop(false)
          plugin.stopSetupHandoff?.()
          if (original) Object.defineProperty(process, 'send', original)
          else delete process.send
        }
      })
    }
  }
})

describe('Cypress nested returned retry getters', () => {
  for (const asynchronous of [false, true]) {
    for (const experimental of [false, true]) {
      it(`retains only recursively materialized overrides (async=${asynchronous}, experimental=${experimental})`,
        async () => {
          const CypressPlugin = require('../../datadog-plugin-cypress/src/cypress-plugin').constructor
          const plugin = new CypressPlugin()
          const project = fs.mkdtempSync(join(tmpdir(), 'dd-cypress-nested-getter-'))
          const original = Object.getOwnPropertyDescriptor(process, 'send')
          let wire
          process.send = message => { wire = JSON.parse(JSON.stringify(message)).args[0].setupConfig }
          const native = experimental
            ? {
                runMode: true,
                openMode: false,
                experimentalStrategy: 'detect-flake-but-always-fail',
                experimentalOptions: { maxRetries: 2, stopIfAnyPassed: false },
              }
            : { runMode: 2, openMode: 0 }
          const config = { version: '16.2.0', projectRoot: project, supportFile: false, retries: native }
          const tracer = {
            _tracer: {
              _config: { isServiceUserProvided: false },
              _exporter: {
                getLibraryConfiguration: (_config, callback) => callback(null, {
                  isFlakyTestRetriesEnabled: true, flakyTestRetriesCount: 4,
                }),
              },
            },
          }
          const handlers = {}
          try {
            await plugin.init(tracer, config)
            let reads = 0
            const retryOverride = experimental
              ? { experimentalOptions: { get maxRetries () { return ++reads } } }
              : { get runMode () { return ++reads } }
            const returned = { retries: retryOverride }
            let ignoredSymbolReads = 0
            Object.defineProperty(returned, Symbol('ignored config field'), {
              enumerable: true,
              get () { ignoredSymbolReads++; return 'ignored' },
            })
            const wrapped = wrapConfig({
              e2e: {
                setupNodeEvents: () => asynchronous ? Promise.resolve(returned) : returned,
              },
            })
            const result = await wrapped.e2e.setupNodeEvents((event, handler) => { handlers[event] = handler }, config)
            process.send({ event: 'setupTestingType:reply', args: [{ setupConfig: result }] })
            assert.strictEqual(ignoredSymbolReads, 0)
            assert.strictEqual(reads, 1)
            assert.deepStrictEqual(plugin.originalCypressRetries,
              experimental
                ? { ...native, experimentalOptions: { maxRetries: 1, stopIfAnyPassed: false } }
                : { runMode: 1, openMode: 0 })
            assert.strictEqual(experimental ? wire.retries.experimentalOptions.maxRetries : wire.retries.runMode, 1)
          } finally {
            plugin.retryConfigObserver?.stop(false)
            plugin.stopSetupHandoff?.()
            if (original) Object.defineProperty(process, 'send', original)
            else delete process.send
            await handlers['after:run']?.({})
            fs.rmSync(project, { recursive: true, force: true })
          }
        })
    }
  }
})

describe('Cypress saved options across Node retry roots', () => {
  for (const define of [false, true]) {
    for (const kind of ['saved', 'detached', 'fresh']) {
      it(`preserves child identity at handoff (define=${define}, kind=${kind})`, async () => {
        const CypressPlugin = require('../../datadog-plugin-cypress/src/cypress-plugin').constructor
        const plugin = new CypressPlugin()
        const config = {
          version: '16.2.0',
          retries: {
            runMode: true,
            openMode: false,
            experimentalStrategy: 'detect-flake-but-always-fail',
            experimentalOptions: { maxRetries: 2, stopIfAnyPassed: false },
          },
        }
        const tracer = {
          _tracer: {
            _config: { isServiceUserProvided: false },
            _exporter: {
              getLibraryConfiguration: (_config, callback) => callback(null, {
                isFlakyTestRetriesEnabled: true, flakyTestRetriesCount: 4,
              }),
            },
          },
        }
        try {
          const result = await plugin.init(tracer, config)
          const saved = result.retries.experimentalOptions
          assert.strictEqual(saved.maxRetries, 4)
          result.retries = { ...result.retries, experimentalOptions: { maxRetries: 1, stopIfAnyPassed: false } }
          if (kind === 'detached') saved.maxRetries = 3
          const selected = kind === 'fresh' ? { maxRetries: 4, stopIfAnyPassed: false } : saved
          if (define) Object.defineProperty(result.retries, 'experimentalOptions', { value: selected })
          else result.retries.experimentalOptions = selected
          plugin.retryConfigObserver.stop()
          assert.strictEqual(plugin.originalCypressRetries.experimentalOptions.maxRetries,
            kind === 'saved' ? 2 : kind === 'detached' ? 3 : 4)
        } finally {
          plugin.retryConfigObserver?.stop(false)
          plugin.stopSetupHandoff?.()
        }
      })
    }
  }
})
