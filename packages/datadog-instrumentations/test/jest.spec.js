'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const log = require('../../dd-trace/src/log')

describe('jest instrumentation', () => {
  let previousJestJasmine

  beforeEach(() => {
    previousJestJasmine = process.env.JEST_JASMINE
  })

  afterEach(() => {
    sinon.restore()
    if (previousJestJasmine === undefined) {
      delete process.env.JEST_JASMINE
    } else {
      process.env.JEST_JASMINE = previousJestJasmine
    }
  })

  /**
   * @param {object[]} configs resolved Jest project configurations
   * @returns {{ readConfigs: () => Promise<object> }}
   */
  function instrumentJestConfig (configs) {
    const hooks = []
    const realInstrument = require('../src/helpers/instrument')

    proxyquire('../src/jest', {
      './helpers/instrument': {
        ...realInstrument,
        addHook (target, hook) {
          hooks.push({ hook, target })
        },
      },
    })

    const configHook = hooks.find(({ target }) => target.name === 'jest-config').hook
    const jestConfig = {
      async readConfigs () {
        return {
          configs: configs.map(config => ({ ...config })),
          globalConfig: {},
        }
      },
    }

    return configHook(jestConfig)
  }

  it('does not warn for default or resolved jest-circus runners', async () => {
    const warn = sinon.stub(log, 'warn')
    const jestConfig = instrumentJestConfig([
      { testRunner: 'jest-circus/runner' },
      { testRunner: '/repo/node_modules/jest-circus/build/runner.js' },
      { testRunner: String.raw`C:\repo\node_modules\jest-circus\build\runner.js` },
    ])

    await jestConfig.readConfigs()

    assert.strictEqual(warn.callCount, 0)
  })

  it('warns when testRunner is not jest-circus', async () => {
    const warn = sinon.stub(log, 'warn')
    const jestConfig = instrumentJestConfig([{
      runner: '/repo/node_modules/jest-circus/build/runner.js',
      testRunner: '/repo/node_modules/jest-jasmine2/build/index.js',
    }])

    await jestConfig.readConfigs()

    assert.strictEqual(warn.callCount, 1)
    assert.match(warn.firstCall.args[0], /supports jest-circus/)
    assert.match(warn.firstCall.args[0], /another test runner was detected/)
    assert.match(warn.firstCall.args[0], /suite and test events may be incomplete/)
  })

  it('warns once across multiple projects and repeated config reads', async () => {
    const warn = sinon.stub(log, 'warn')
    const jestConfig = instrumentJestConfig([
      { testRunner: '/repo/node_modules/jest-jasmine2/build/index.js' },
      { testRunner: '/repo/custom-runner/index.js' },
    ])

    await jestConfig.readConfigs()
    await jestConfig.readConfigs()

    assert.strictEqual(warn.callCount, 1)
  })

  it('warns when JEST_JASMINE=1 overrides a resolved jest-circus runner', async () => {
    process.env.JEST_JASMINE = '1'
    const warn = sinon.stub(log, 'warn')
    const jestConfig = instrumentJestConfig([
      { testRunner: '/repo/node_modules/jest-circus/build/runner.js' },
    ])

    await jestConfig.readConfigs()

    assert.strictEqual(warn.callCount, 1)
  })
})
