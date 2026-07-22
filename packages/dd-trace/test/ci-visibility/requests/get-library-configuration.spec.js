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
        earlyFlakeDetectionRetryPolicy: {
          durationRetryCounts: [
            { durationLimitMs: 5000, retryCount: 4 },
            { durationLimitMs: 10_000, retryCount: 3 },
            { durationLimitMs: 30_000, retryCount: 0 },
            { durationLimitMs: 300_000, retryCount: 0 },
          ],
          schedulingRetryCount: 4,
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

    it('normalizes missing, empty, sparse, and all-zero EFD retry budgets', () => {
      const missingRetryBudget = parseLibraryConfigurationResponse({
        early_flake_detection: {
          enabled: true,
        },
      })
      const emptyRetryBudget = parseLibraryConfigurationResponse({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {},
        },
      })
      const sparseRetryBudget = parseLibraryConfigurationResponse({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '10s': 3,
          },
        },
      })
      const zeroRetryBudget = parseLibraryConfigurationResponse({
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 0,
            '10s': 0,
          },
        },
      })

      assert.strictEqual(missingRetryBudget.earlyFlakeDetectionRetryPolicy.schedulingRetryCount, 10)
      assert.strictEqual(emptyRetryBudget.earlyFlakeDetectionRetryPolicy.schedulingRetryCount, 0)
      assert.strictEqual(sparseRetryBudget.earlyFlakeDetectionRetryPolicy.schedulingRetryCount, 3)
      assert.strictEqual(zeroRetryBudget.earlyFlakeDetectionRetryPolicy.schedulingRetryCount, 0)
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
