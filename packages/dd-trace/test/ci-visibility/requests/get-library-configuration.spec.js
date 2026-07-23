'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')

require('../../setup/core')

const getConfig = require('../../../src/config')
const {
  parseLibraryConfigurationResponse,
} = require('../../../src/ci-visibility/requests/get-library-configuration')

const COMPLETE_SETTINGS_ATTRIBUTES = {
  code_coverage: true,
  tests_skipping: true,
  itr_enabled: true,
  require_git: false,
  early_flake_detection: {
    enabled: true,
    slow_test_retries: {
      '5s': 4,
      '10s': 3,
    },
    faulty_session_threshold: 12,
  },
  flaky_test_retries_enabled: true,
  di_enabled: true,
  known_tests_enabled: true,
  test_management: {
    enabled: true,
    attempt_to_fix_retries: 8,
  },
  impacted_tests_enabled: true,
  coverage_report_upload_enabled: true,
}

describe('get-library-configuration', () => {
  beforeEach(() => {
    getConfig().testOptimization.DD_CIVISIBILITY_CODE_COVERAGE_REPORT_UPLOAD_ENABLED = true
    getConfig().testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_COVERAGE = false
    getConfig().testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_TEST_SKIPPING = false
  })

  afterEach(() => {
    getConfig().testOptimization.DD_CIVISIBILITY_CODE_COVERAGE_REPORT_UPLOAD_ENABLED = true
    getConfig().testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_COVERAGE = false
    getConfig().testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_TEST_SKIPPING = false
  })

  describe('parseLibraryConfigurationResponse', () => {
    it('normalizes raw settings responses', () => {
      const settings = parseLibraryConfigurationResponse(JSON.stringify({
        data: {
          attributes: COMPLETE_SETTINGS_ATTRIBUTES,
        },
      }))

      assert.deepStrictEqual(settings, {
        isCodeCoverageEnabled: true,
        isSuitesSkippingEnabled: true,
        isItrEnabled: true,
        requireGit: false,
        isEarlyFlakeDetectionEnabled: true,
        earlyFlakeDetectionNumRetries: 4,
        earlyFlakeDetectionSlowTestRetries: {
          '5s': 4,
          '10s': 3,
        },
        earlyFlakeDetectionFaultyThreshold: 12,
        isFlakyTestRetriesEnabled: true,
        isDiEnabled: true,
        isKnownTestsEnabled: true,
        isTestManagementEnabled: true,
        testManagementAttemptToFixRetries: 8,
        isImpactedTestsEnabled: true,
        isCoverageReportUploadEnabled: true,
      })
      assert.strictEqual(Object.isFrozen(settings), true)
      assert.strictEqual(Object.isFrozen(settings.earlyFlakeDetectionSlowTestRetries), true)
    })

    it('accepts bare settings attributes like the Ruby cache reader', () => {
      const settings = parseLibraryConfigurationResponse(JSON.stringify({
        code_coverage: true,
        tests_skipping: false,
        itr_enabled: true,
        require_git: false,
        known_tests_enabled: false,
      }))

      assert.strictEqual(settings.isCodeCoverageEnabled, true)
      assert.strictEqual(settings.isSuitesSkippingEnabled, false)
      assert.strictEqual(settings.isItrEnabled, true)
      assert.strictEqual(settings.requireGit, false)
      assert.strictEqual(settings.isEarlyFlakeDetectionEnabled, false)
    })

    it('rejects non-object settings responses', () => {
      for (const response of ['null', '[]', '"settings"']) {
        assert.throws(
          () => parseLibraryConfigurationResponse(response),
          {
            name: 'TypeError',
            message: 'Invalid settings response: attributes must be an object',
          }
        )
      }
    })

    it('does not enable boolean settings with non-boolean values', () => {
      const booleanSettings = [
        ['code_coverage', 'isCodeCoverageEnabled'],
        ['tests_skipping', 'isSuitesSkippingEnabled'],
        ['itr_enabled', 'isItrEnabled'],
        ['require_git', 'requireGit'],
        ['flaky_test_retries_enabled', 'isFlakyTestRetriesEnabled'],
        ['di_enabled', 'isDiEnabled'],
        ['known_tests_enabled', 'isKnownTestsEnabled'],
        ['impacted_tests_enabled', 'isImpactedTestsEnabled'],
        ['coverage_report_upload_enabled', 'isCoverageReportUploadEnabled'],
      ]

      for (const [responseKey, settingsKey] of booleanSettings) {
        const attributes = {
          ...COMPLETE_SETTINGS_ATTRIBUTES,
          [responseKey]: 'true',
        }
        const settings = parseLibraryConfigurationResponse(attributes)

        assert.strictEqual(settings[settingsKey], false, responseKey)
      }
    })

    it('disables EFD when its retry policy is malformed', () => {
      const malformedPolicies = [
        { enabled: 'true' },
        { enabled: true, slow_test_retries: [] },
        { enabled: true, slow_test_retries: { '5s': -1 } },
        { enabled: true, slow_test_retries: { '5s': 1.5 } },
        { enabled: true, slow_test_retries: { '5s': '1' } },
        { enabled: true, slow_test_retries: { '5s': 101 } },
        { enabled: true, slow_test_retries: { '5s': Number.MAX_SAFE_INTEGER } },
        { enabled: true, faulty_session_threshold: -1 },
        { enabled: true, faulty_session_threshold: 101 },
        { enabled: true, faulty_session_threshold: 1.5 },
      ]

      for (const earlyFlakeDetection of malformedPolicies) {
        const settings = parseLibraryConfigurationResponse({
          early_flake_detection: earlyFlakeDetection,
          known_tests_enabled: true,
        })

        assert.strictEqual(settings.isEarlyFlakeDetectionEnabled, false)
        assert.strictEqual(Object.isFrozen(settings.earlyFlakeDetectionSlowTestRetries), true)
      }
    })

    it('ignores unknown settings and EFD retry buckets', () => {
      const settings = parseLibraryConfigurationResponse({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 0,
            future: 'unknown',
          },
          future: true,
        },
        known_tests_enabled: true,
        future: true,
      })

      assert.strictEqual(settings.isEarlyFlakeDetectionEnabled, true)
      assert.strictEqual(settings.earlyFlakeDetectionNumRetries, 0)
      assert.deepStrictEqual(settings.earlyFlakeDetectionSlowTestRetries, { '5s': 0 })
    })

    it('disables test management when its retry policy is malformed', () => {
      for (const attemptToFixRetries of [-1, 1.5, '1', 101, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY]) {
        const settings = parseLibraryConfigurationResponse({
          test_management: {
            enabled: true,
            attempt_to_fix_retries: attemptToFixRetries,
          },
        })

        assert.strictEqual(settings.isTestManagementEnabled, false)
        assert.strictEqual(settings.testManagementAttemptToFixRetries, undefined)
      }

      const settings = parseLibraryConfigurationResponse({
        test_management: {
          enabled: 'true',
          attempt_to_fix_retries: 1,
        },
      })
      assert.strictEqual(settings.isTestManagementEnabled, false)
    })

    it('accepts the maximum retry count', () => {
      const settings = parseLibraryConfigurationResponse({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 100,
          },
        },
        known_tests_enabled: true,
        test_management: {
          enabled: true,
          attempt_to_fix_retries: 100,
        },
      })

      assert.strictEqual(settings.isEarlyFlakeDetectionEnabled, true)
      assert.strictEqual(settings.earlyFlakeDetectionNumRetries, 100)
      assert.strictEqual(settings.isTestManagementEnabled, true)
      assert.strictEqual(settings.testManagementAttemptToFixRetries, 100)
    })

    it('defaults missing EFD retry budgets without replacing an explicit zero', () => {
      const missingRetryBudget = parseLibraryConfigurationResponse({
        early_flake_detection: {
          enabled: true,
        },
      })
      const missingFiveSecondRetryBudget = parseLibraryConfigurationResponse({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '10s': 1,
          },
        },
      })
      const zeroRetryBudget = parseLibraryConfigurationResponse({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 0,
          },
        },
      })

      assert.strictEqual(missingRetryBudget.earlyFlakeDetectionNumRetries, 2)
      assert.strictEqual(missingFiveSecondRetryBudget.earlyFlakeDetectionNumRetries, 2)
      assert.strictEqual(zeroRetryBudget.earlyFlakeDetectionNumRetries, 0)
    })

    it('validates complete cached settings attributes', () => {
      const apiSettings = parseLibraryConfigurationResponse(JSON.stringify({
        data: {
          attributes: COMPLETE_SETTINGS_ATTRIBUTES,
        },
      }), undefined, { validateRequiredFields: true })
      const bareSettings = parseLibraryConfigurationResponse(
        JSON.stringify(COMPLETE_SETTINGS_ATTRIBUTES),
        undefined,
        { validateRequiredFields: true }
      )

      assert.strictEqual(apiSettings.isCodeCoverageEnabled, true)
      assert.strictEqual(bareSettings.isCodeCoverageEnabled, true)
    })

    it('rejects cached settings without all required attributes', () => {
      const partialSettingsAttributes = { ...COMPLETE_SETTINGS_ATTRIBUTES }
      delete partialSettingsAttributes.require_git

      assert.throws(
        () => parseLibraryConfigurationResponse(JSON.stringify({}), undefined, { validateRequiredFields: true }),
        /Invalid settings response: missing code_coverage/
      )
      assert.throws(
        () => parseLibraryConfigurationResponse(
          JSON.stringify({ data: { attributes: {} } }),
          undefined,
          { validateRequiredFields: true }
        ),
        /Invalid settings response: missing code_coverage/
      )
      assert.throws(
        () => parseLibraryConfigurationResponse(
          JSON.stringify({ data: { attributes: partialSettingsAttributes } }),
          undefined,
          { validateRequiredFields: true }
        ),
        /Invalid settings response: missing require_git/
      )
    })

    it('applies dangerous force flags after parsing', () => {
      getConfig().testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_COVERAGE = true
      getConfig().testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_TEST_SKIPPING = true

      const settings = parseLibraryConfigurationResponse(JSON.stringify({
        data: {
          attributes: {
            code_coverage: false,
            tests_skipping: false,
            itr_enabled: true,
            require_git: false,
          },
        },
      }))

      assert.strictEqual(settings.isCodeCoverageEnabled, true)
      assert.strictEqual(settings.isSuitesSkippingEnabled, true)
    })

    it('disables code coverage report upload when the environment override is false', () => {
      getConfig().testOptimization.DD_CIVISIBILITY_CODE_COVERAGE_REPORT_UPLOAD_ENABLED = false

      const settings = parseLibraryConfigurationResponse(JSON.stringify({
        data: {
          attributes: COMPLETE_SETTINGS_ATTRIBUTES,
        },
      }))

      assert.strictEqual(settings.isCoverageReportUploadEnabled, false)
    })

    it('does not enable code coverage report upload when the environment override is true', () => {
      const settings = parseLibraryConfigurationResponse(JSON.stringify({
        data: {
          attributes: {
            ...COMPLETE_SETTINGS_ATTRIBUTES,
            coverage_report_upload_enabled: false,
          },
        },
      }))

      assert.strictEqual(settings.isCoverageReportUploadEnabled, false)
    })
  })
})
