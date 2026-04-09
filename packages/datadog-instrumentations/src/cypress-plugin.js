'use strict'

const { channel } = require('dc-polyfill')

const TEST_FRAMEWORK_NAME = 'cypress'

const libraryConfigurationCh = channel(`ci:${TEST_FRAMEWORK_NAME}:library-configuration`)
const configureCh = channel(`ci:${TEST_FRAMEWORK_NAME}:configure`)
const beforeRunCh = channel(`ci:${TEST_FRAMEWORK_NAME}:before-run`)
const testSuiteStartCh = channel(`ci:${TEST_FRAMEWORK_NAME}:test-suite:start`)
const testStartCh = channel(`ci:${TEST_FRAMEWORK_NAME}:test:start`)
const coverageCh = channel(`ci:${TEST_FRAMEWORK_NAME}:coverage`)
const testFinishCh = channel(`ci:${TEST_FRAMEWORK_NAME}:test:finish`)
const afterSpecCh = channel(`ci:${TEST_FRAMEWORK_NAME}:after-spec`)
const sessionFinishCh = channel(`ci:${TEST_FRAMEWORK_NAME}:session:finish`)

class CypressPlugin {
  _isInit = false

  resetRunState () {
    this._isInit = false
    this.libraryConfigurationPromise = undefined
  }

  init (cypressConfig) {
    this.resetRunState()
    this._isInit = true

    this.libraryConfigurationPromise = new Promise(function (resolve) {
      if (!libraryConfigurationCh.hasSubscribers) {
        return resolve({ err: new Error('Test optimization was not initialized correctly') })
      }
      libraryConfigurationCh.publish({ onDone: resolve, frameworkVersion: undefined })
    }).then(function () {
      if (configureCh.hasSubscribers) {
        configureCh.publish({ cypressConfig })
      }
      return cypressConfig
    })

    return this.libraryConfigurationPromise
  }

  beforeRun (details) {
    return this.libraryConfigurationPromise.then(function () {
      if (!beforeRunCh.hasSubscribers) {
        return details
      }
      return new Promise(function (resolve) {
        beforeRunCh.publish({ details, onDone: resolve })
      }).then(function () { return details })
    })
  }

  afterRun (suiteStats) {
    if (!this._isInit) {
      return
    }
    const self = this
    return new Promise(function (resolve) {
      if (!sessionFinishCh.hasSubscribers) {
        self._isInit = false
        resolve(null)
        return
      }
      sessionFinishCh.publish({
        suiteStats,
        onDone: function () {
          self._isInit = false
          resolve(null)
        },
      })
    })
  }

  afterSpec (spec, results) {
    if (afterSpecCh.hasSubscribers) {
      afterSpecCh.publish({ spec, results })
    }
  }

  getTasks () {
    return {
      'dd:testSuiteStart': function (payload) {
        const ctx = { payload, suitePayload: null }
        if (testSuiteStartCh.hasSubscribers) {
          testSuiteStartCh.publish(ctx)
        }
        return ctx.suitePayload
      },
      'dd:beforeEach': function (test) {
        const ctx = { test, result: null }
        if (testStartCh.hasSubscribers) {
          testStartCh.publish(ctx)
        }
        return ctx.result === null ? {} : ctx.result
      },
      'dd:afterEach': function ({ test, coverage }) {
        if (coverageCh.hasSubscribers) {
          coverageCh.publish({ test, coverage })
        }
        if (testFinishCh.hasSubscribers) {
          testFinishCh.publish({ test })
        }
        return null
      },
      'dd:addTags': function (tags) {
        const addTagsCh = channel(`ci:${TEST_FRAMEWORK_NAME}:test:add-tags`)
        if (addTagsCh.hasSubscribers) {
          addTagsCh.publish(tags)
        }
        return null
      },
      'dd:log': function (message) {
        // eslint-disable-next-line no-console
        console.log(`[datadog] ${message}`)
        return null
      },
    }
  }
}

module.exports = new CypressPlugin()
