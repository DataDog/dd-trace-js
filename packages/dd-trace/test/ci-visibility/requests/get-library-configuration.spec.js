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
    getConfig().DD_CIVISIBILITY_DANGEROUSLY_FORCE_COVERAGE = false
    getConfig().DD_CIVISIBILITY_DANGEROUSLY_FORCE_TEST_SKIPPING = false
  })

  afterEach(() => {
    getConfig().DD_CIVISIBILITY_DANGEROUSLY_FORCE_COVERAGE = false
    getConfig().DD_CIVISIBILITY_DANGEROUSLY_FORCE_TEST_SKIPPING = false
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
      getConfig().DD_CIVISIBILITY_DANGEROUSLY_FORCE_COVERAGE = true
      getConfig().DD_CIVISIBILITY_DANGEROUSLY_FORCE_TEST_SKIPPING = true

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
  })
})
