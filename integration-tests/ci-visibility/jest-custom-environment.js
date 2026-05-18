'use strict'

const { createContext, runInContext } = require('node:vm')
const { LegacyFakeTimers, ModernFakeTimers } = require('@jest/fake-timers')
const { installCommonGlobals } = require('jest-util')
const { ModuleMocker } = require('jest-mock')

const timerIdToRef = id => ({
  id,
  ref () {
    return this
  },
  unref () {
    return this
  },
})

const timerRefToId = timer => timer?.id

function installNodeGlobals (globalObject) {
  globalObject.global = globalObject
  globalObject.Buffer = Buffer
  globalObject.ArrayBuffer = ArrayBuffer
  globalObject.Uint8Array = Uint8Array
  globalObject.setTimeout = setTimeout
  globalObject.clearTimeout = clearTimeout
  globalObject.setInterval = setInterval
  globalObject.clearInterval = clearInterval
  globalObject.setImmediate = setImmediate
  globalObject.clearImmediate = clearImmediate
  globalObject.queueMicrotask = queueMicrotask
}

class DatadogCustomJestEnvironment {
  constructor (config) {
    const { projectConfig } = config

    this.customExportConditions = ['node', 'node-addons']
    this.context = createContext({})
    this.global = runInContext('this', this.context)

    installNodeGlobals(this.global)
    installCommonGlobals(this.global, projectConfig.globals)

    this.moduleMocker = new ModuleMocker(this.global)
    this.fakeTimers = new LegacyFakeTimers({
      config: projectConfig,
      global: this.global,
      moduleMocker: this.moduleMocker,
      timerConfig: {
        idToRef: timerIdToRef,
        refToId: timerRefToId,
      },
    })
    this.fakeTimersModern = new ModernFakeTimers({
      config: projectConfig,
      global: this.global,
    })
  }

  async setup () {
    this.global.__DD_CUSTOM_JEST_ENVIRONMENT__ = true
  }

  async teardown () {
    this.fakeTimers?.dispose()
    this.fakeTimersModern?.dispose()
    this.context = null
    this.fakeTimers = null
    this.fakeTimersModern = null
  }

  exportConditions () {
    return this.customExportConditions
  }

  getVmContext () {
    return this.context
  }

  async handleTestEvent (event) {
    if (event.name === 'test_start') {
      this.global.__DD_CUSTOM_JEST_ENVIRONMENT_TEST_STARTED__ = event.test.name
    }
  }
}

module.exports = DatadogCustomJestEnvironment
