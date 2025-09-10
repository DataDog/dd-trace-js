'use strict'

const { validateSpanData, validateSpansCollection, getSupportedIntegrationTypes } = require('./apm-data-requirements')

/**
 * APM Test Validator
 *
 * Utility class for validating spans in APM test environments.
 * Designed to be used by test agents to verify integration data completeness.
 */
class APMTestValidator {
  constructor (options = {}) {
    this.options = {
      strictMode: options.strictMode || false, // Fail on any missing critical data
      minCompleteness: options.minCompleteness || 0.7, // Minimum completeness score
      logResults: options.logResults !== false, // Log validation results
      ...options
    }
  }

  /**
   * Validate a single span
   * @param {Object} span - Span object to validate
   * @param {string} integrationType - Expected integration type
   * @returns {Object} Validation result
   */
  validateSpan (span, integrationType) {
    const result = validateSpanData(span, integrationType, this.options)

    if (this.options.logResults) {
      this._logSpanValidation(span, integrationType, result)
    }

    return result
  }

  /**
   * Validate multiple spans from a test run
   * @param {Array} spans - Array of spans to validate
   * @param {string} integrationType - Expected integration type
   * @returns {Object} Aggregate validation report
   */
  validateTestRun (spans, integrationType) {
    const report = validateSpansCollection(spans, integrationType, this.options)

    if (this.options.logResults) {
      this._logTestRunValidation(integrationType, report)
    }

    return report
  }

  /**
   * Assert that a span meets validation requirements
   * @param {Object} span - Span to validate
   * @param {string} integrationType - Expected integration type
   * @throws {Error} If validation fails
   */
  assertSpanValid (span, integrationType) {
    const result = this.validateSpan(span, integrationType)

    if (!result.valid) {
      const errors = result.missing
        .filter(m => m.required)
        .map(m => `Missing required ${m.level} field: ${m.field}`)

      errors.push(...result.invalid.map(i => `Invalid ${i.level} field ${i.field}: ${i.error}`))

      throw new Error(`Span validation failed for ${integrationType}:\n${errors.join('\n')}`)
    }

    if (result.completeness < this.options.minCompleteness) {
      throw new Error(
        `Span completeness too low: ${(result.completeness * 100).toFixed(1)}% < ${(this.options.minCompleteness * 100)}%`
      )
    }

    return result
  }

  /**
   * Assert that a test run meets validation requirements
   * @param {Array} spans - Spans from test run
   * @param {string} integrationType - Expected integration type
   * @throws {Error} If validation fails
   */
  assertTestRunValid (spans, integrationType) {
    const report = this.validateTestRun(spans, integrationType)

    if (this.options.strictMode && report.validSpans < report.totalSpans) {
      throw new Error(
        `Test run validation failed: ${report.validSpans}/${report.totalSpans} spans valid (strict mode)`
      )
    }

    if (report.averageCompleteness < this.options.minCompleteness) {
      throw new Error(
        `Test run average completeness too low: ${(report.averageCompleteness * 100).toFixed(1)}% < ${(this.options.minCompleteness * 100)}%`
      )
    }

    return report
  }

  /**
   * Get validation summary for debugging
   * @param {Object} span - Span to analyze
   * @param {string} integrationType - Integration type
   * @returns {string} Human-readable summary
   */
  getValidationSummary (span, integrationType) {
    const result = this.validateSpan(span, integrationType)
    const lines = []

    lines.push(`=== Span Validation Summary: ${integrationType} ===`)
    lines.push(`Valid: ${result.valid ? '✅' : '❌'}`)
    lines.push(`Completeness: ${(result.completeness * 100).toFixed(1)}%`)
    lines.push(`Score: ${result.score.toFixed(2)}/${result.totalPossibleScore}`)

    if (result.present.length > 0) {
      lines.push(`\n✅ Present Fields (${result.present.length}):`)
      result.present.forEach(field => lines.push(`  • ${field}`))
    }

    if (result.missing.length > 0) {
      lines.push(`\n❌ Missing Fields (${result.missing.length}):`)
      result.missing.forEach(missing => {
        const required = missing.required ? ' (REQUIRED)' : ''
        lines.push(`  • ${missing.level}.${missing.field}${required}`)
      })
    }

    if (result.invalid.length > 0) {
      lines.push(`\n⚠️  Invalid Fields (${result.invalid.length}):`)
      result.invalid.forEach(invalid => {
        lines.push(`  • ${invalid.level}.${invalid.field}: ${invalid.error}`)
      })
    }

    return lines.join('\n')
  }

  /**
   * Generate test report for CI/CD integration
   * @param {Array} spans - Test spans
   * @param {string} integrationType - Integration type
   * @returns {Object} CI-friendly test report
   */
  generateTestReport (spans, integrationType) {
    const report = this.validateTestRun(spans, integrationType)

    return {
      integration: integrationType,
      timestamp: new Date().toISOString(),
      summary: {
        totalSpans: report.totalSpans,
        validSpans: report.validSpans,
        invalidSpans: report.totalSpans - report.validSpans,
        successRate: (report.validSpans / report.totalSpans * 100).toFixed(1) + '%',
        averageCompleteness: (report.averageCompleteness * 100).toFixed(1) + '%'
      },
      issues: {
        commonMissingFields: Object.entries(report.commonMissingFields)
          .sort(([,a], [,b]) => b - a)
          .slice(0, 5)
          .map(([field, count]) => ({ field, count, percentage: (count / report.totalSpans * 100).toFixed(1) + '%' })),
        commonInvalidFields: Object.entries(report.commonInvalidFields)
          .sort(([,a], [,b]) => b - a)
          .slice(0, 5)
          .map(([field, count]) => ({ field, count, percentage: (count / report.totalSpans * 100).toFixed(1) + '%' }))
      },
      recommendations: this._generateRecommendations(report, integrationType),
      passed: report.validSpans === report.totalSpans && report.averageCompleteness >= this.options.minCompleteness
    }
  }

  /**
   * Log span validation result
   * @private
   */
  _logSpanValidation (span, integrationType, result) {
    const spanId = span.span_id || span.spanId || 'unknown'
    const status = result.valid ? '✅' : '❌'
    const completeness = (result.completeness * 100).toFixed(1)

    console.log(`${status} Span ${spanId} (${integrationType}): ${completeness}% complete`)

    if (!result.valid && result.missing.some(m => m.required)) {
      const requiredMissing = result.missing.filter(m => m.required)
      console.log(`  Missing required fields: ${requiredMissing.map(m => m.field).join(', ')}`)
    }
  }

  /**
   * Log test run validation result
   * @private
   */
  _logTestRunValidation (integrationType, report) {
    console.log(`\n=== Test Run Validation: ${integrationType} ===`)
    console.log(`Spans: ${report.validSpans}/${report.totalSpans} valid (${(report.validSpans / report.totalSpans * 100).toFixed(1)}%)`)
    console.log(`Average Completeness: ${(report.averageCompleteness * 100).toFixed(1)}%`)

    if (Object.keys(report.commonMissingFields).length > 0) {
      console.log('\nMost Common Missing Fields:')
      Object.entries(report.commonMissingFields)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 3)
        .forEach(([field, count]) => {
          console.log(`  • ${field}: ${count}/${report.totalSpans} spans (${(count / report.totalSpans * 100).toFixed(1)}%)`)
        })
    }
  }

  /**
   * Generate recommendations based on validation results
   * @private
   */
  _generateRecommendations (report, integrationType) {
    const recommendations = []

    // Check for commonly missing critical fields
    const criticalMissing = Object.entries(report.commonMissingFields)
      .filter(([field]) => field.startsWith('critical.'))
      .sort(([,a], [,b]) => b - a)

    if (criticalMissing.length > 0) {
      const [mostMissing] = criticalMissing[0]
      const fieldName = mostMissing.split('.')[1]
      recommendations.push({
        type: 'critical',
        issue: `Critical field '${fieldName}' missing in ${report.commonMissingFields[mostMissing]} spans`,
        action: `Ensure instrumentation captures ${fieldName} data from function arguments or context`
      })
    }

    // Check for low completeness
    if (report.averageCompleteness < 0.8) {
      recommendations.push({
        type: 'improvement',
        issue: `Low average completeness: ${(report.averageCompleteness * 100).toFixed(1)}%`,
        action: 'Review instrumentation to capture more optional fields for better observability'
      })
    }

    // Check for validation errors
    const invalidFields = Object.entries(report.commonInvalidFields)
    if (invalidFields.length > 0) {
      recommendations.push({
        type: 'validation',
        issue: `Data validation errors in ${invalidFields.length} field types`,
        action: 'Review data sanitization and type conversion in instrumentation code'
      })
    }

    return recommendations
  }
}

/**
 * Create a validator instance with common test settings
 * @param {Object} options - Validator options
 * @returns {APMTestValidator} Configured validator
 */
function createTestValidator (options = {}) {
  return new APMTestValidator({
    strictMode: false,
    minCompleteness: 0.7,
    logResults: true,
    ...options
  })
}

/**
 * Create a strict validator for CI/CD environments
 * @param {Object} options - Validator options
 * @returns {APMTestValidator} Strict validator
 */
function createStrictValidator (options = {}) {
  return new APMTestValidator({
    strictMode: true,
    minCompleteness: 0.9,
    logResults: false,
    ...options
  })
}

module.exports = {
  APMTestValidator,
  createTestValidator,
  createStrictValidator,
  getSupportedIntegrationTypes
}
