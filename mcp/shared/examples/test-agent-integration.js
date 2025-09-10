'use strict'

/**
 * Example: Using generic data requirements in APM test agents
 *
 * This shows how test agents can validate spans against the generic
 * data requirements to ensure integration quality.
 */

const { createTestValidator, createStrictValidator } = require('../apm-test-validator')

/**
 * Example APM Test Agent that validates spans
 */
class APMTestAgent {
  constructor (options = {}) {
    this.validator = options.strict
      ? createStrictValidator(options.validatorOptions)
      : createTestValidator(options.validatorOptions)

    this.spans = []
    this.integrationResults = new Map()
  }

  /**
   * Receive a span from the application under test
   * @param {Object} span - Span object with tags and metadata
   */
  receiveSpan (span) {
    this.spans.push({
      ...span,
      receivedAt: Date.now()
    })
  }

  /**
   * Validate spans for a specific integration
   * @param {string} integrationType - Integration type to validate
   * @returns {Object} Validation report
   */
  validateIntegration (integrationType) {
    // Filter spans that likely belong to this integration
    const integrationSpans = this.filterSpansForIntegration(integrationType)

    if (integrationSpans.length === 0) {
      return {
        integration: integrationType,
        error: 'No spans found for integration',
        spans: 0
      }
    }

    const report = this.validator.generateTestReport(integrationSpans, integrationType)
    this.integrationResults.set(integrationType, report)

    return report
  }

  /**
   * Assert that an integration meets quality standards
   * @param {string} integrationType - Integration type
   * @throws {Error} If validation fails
   */
  assertIntegrationQuality (integrationType) {
    const integrationSpans = this.filterSpansForIntegration(integrationType)
    return this.validator.assertTestRunValid(integrationSpans, integrationType)
  }

  /**
   * Get detailed validation results for debugging
   * @param {string} integrationType - Integration type
   * @returns {Array} Detailed span validation results
   */
  getDetailedResults (integrationType) {
    const integrationSpans = this.filterSpansForIntegration(integrationType)

    return integrationSpans.map(span => ({
      span,
      validation: this.validator.validateSpan(span, integrationType),
      summary: this.validator.getValidationSummary(span, integrationType)
    }))
  }

  /**
   * Generate CI/CD report for all integrations
   * @returns {Object} Comprehensive test report
   */
  generateCIReport () {
    const integrations = this.detectIntegrations()
    const reports = {}

    integrations.forEach(integrationType => {
      reports[integrationType] = this.validateIntegration(integrationType)
    })

    const overallStats = this.calculateOverallStats(reports)

    return {
      timestamp: new Date().toISOString(),
      totalSpans: this.spans.length,
      integrations: reports,
      overall: overallStats,
      recommendations: this.generateOverallRecommendations(reports)
    }
  }

  /**
   * Filter spans that belong to a specific integration
   * @private
   */
  filterSpansForIntegration (integrationType) {
    const [category, subcategory] = integrationType.split('-')

    return this.spans.filter(span => {
      const meta = span.meta || span.tags || {}

      // Check for integration-specific tags
      if (meta.component && this.matchesIntegrationType(meta.component, integrationType)) {
        return true
      }

      // Check for span type indicators
      if (span.type || meta['span.type']) {
        const spanType = span.type || meta['span.type']
        if (this.spanTypeMatchesIntegration(spanType, category)) {
          return true
        }
      }

      // Check for operation name patterns
      const operationName = span.name || span.operationName || meta['operation.name']
      if (operationName && this.operationMatchesIntegration(operationName, integrationType)) {
        return true
      }

      return false
    })
  }

  /**
   * Check if component name matches integration type
   * @private
   */
  matchesIntegrationType (component, integrationType) {
    const [category, subcategory] = integrationType.split('-')

    // Direct component name matches
    const componentMappings = {
      'http-client': ['http', 'axios', 'got', 'fetch', 'request'],
      'http-server': ['express', 'koa', 'fastify', 'hapi', 'http'],
      'database-client': ['mysql', 'postgresql', 'mongodb', 'redis', 'sqlite'],
      'messaging-producer': ['kafka', 'rabbitmq', 'sqs', 'sns'],
      'messaging-consumer': ['kafka', 'rabbitmq', 'sqs', 'sns']
    }

    const expectedComponents = componentMappings[integrationType] || []
    return expectedComponents.some(expected =>
      component.toLowerCase().includes(expected.toLowerCase())
    )
  }

  /**
   * Check if span type matches integration category
   * @private
   */
  spanTypeMatchesIntegration (spanType, category) {
    const typeMappings = {
      http: ['http', 'web'],
      database: ['sql', 'db', 'database'],
      messaging: ['messaging', 'queue'],
      cache: ['cache', 'redis']
    }

    const expectedTypes = typeMappings[category] || []
    return expectedTypes.some(expected =>
      spanType.toLowerCase().includes(expected.toLowerCase())
    )
  }

  /**
   * Check if operation name matches integration
   * @private
   */
  operationMatchesIntegration (operationName, integrationType) {
    const [category, subcategory] = integrationType.split('-')

    const operationPatterns = {
      'http-client': /\.(get|post|put|delete|request|fetch)/i,
      'http-server': /\.(handle|route|middleware)/i,
      'database-client': /\.(query|find|insert|update|delete|execute)/i,
      'messaging-producer': /\.(publish|send|produce)/i,
      'messaging-consumer': /\.(consume|receive|subscribe)/i
    }

    const pattern = operationPatterns[integrationType]
    return pattern ? pattern.test(operationName) : false
  }

  /**
   * Detect integration types from received spans
   * @private
   */
  detectIntegrations () {
    const integrations = new Set()

    // Try to detect integrations from span metadata
    this.spans.forEach(span => {
      const meta = span.meta || span.tags || {}

      // Check component tags
      if (meta.component) {
        Object.keys({
          'http-client': true,
          'http-server': true,
          'database-client': true,
          'messaging-producer': true,
          'messaging-consumer': true
        }).forEach(integrationType => {
          if (this.matchesIntegrationType(meta.component, integrationType)) {
            integrations.add(integrationType)
          }
        })
      }
    })

    return Array.from(integrations)
  }

  /**
   * Calculate overall statistics across all integrations
   * @private
   */
  calculateOverallStats (reports) {
    const values = Object.values(reports).filter(r => !r.error)

    if (values.length === 0) {
      return { totalIntegrations: 0, averageSuccessRate: 0, averageCompleteness: 0 }
    }

    const totalSpans = values.reduce((sum, r) => sum + r.summary.totalSpans, 0)
    const validSpans = values.reduce((sum, r) => sum + r.summary.validSpans, 0)
    const avgCompleteness = values.reduce((sum, r) => sum + parseFloat(r.summary.averageCompleteness), 0) / values.length

    return {
      totalIntegrations: values.length,
      totalSpans,
      validSpans,
      successRate: totalSpans > 0 ? (validSpans / totalSpans * 100).toFixed(1) + '%' : '0%',
      averageCompleteness: avgCompleteness.toFixed(1) + '%'
    }
  }

  /**
   * Generate overall recommendations
   * @private
   */
  generateOverallRecommendations (reports) {
    const recommendations = []
    const allRecommendations = []

    Object.values(reports).forEach(report => {
      if (report.recommendations) {
        allRecommendations.push(...report.recommendations)
      }
    })

    // Group by type and find most common issues
    const issueTypes = {}
    allRecommendations.forEach(rec => {
      issueTypes[rec.type] = (issueTypes[rec.type] || 0) + 1
    })

    if (issueTypes.critical > 0) {
      recommendations.push({
        priority: 'high',
        issue: `${issueTypes.critical} critical data issues found across integrations`,
        action: 'Review instrumentation to ensure critical span data is captured'
      })
    }

    if (issueTypes.validation > 0) {
      recommendations.push({
        priority: 'medium',
        issue: `${issueTypes.validation} data validation issues found`,
        action: 'Improve data type handling and sanitization in instrumentation'
      })
    }

    return recommendations
  }
}

/**
 * Example usage in a test suite
 */
async function exampleTestSuite () {
  const testAgent = new APMTestAgent({ strict: false })

  // Simulate receiving spans during test execution
  const mockSpans = [
    {
      span_id: '12345',
      name: 'axios.get',
      type: 'http',
      meta: {
        component: 'axios',
        'http.url': 'https://api.example.com/users',
        'http.method': 'GET',
        'http.status_code': '200'
      }
    },
    {
      span_id: '67890',
      name: 'mysql.query',
      type: 'sql',
      meta: {
        component: 'mysql',
        'db.statement': 'SELECT * FROM users WHERE id = ?',
        'db.system': 'mysql',
        'db.name': 'app_db'
      }
    }
  ]

  mockSpans.forEach(span => testAgent.receiveSpan(span))

  // Validate specific integrations
  try {
    const httpReport = testAgent.validateIntegration('http-client')
    console.log('HTTP Client Validation:', httpReport.passed ? '✅ PASS' : '❌ FAIL')

    const dbReport = testAgent.validateIntegration('database-client')
    console.log('Database Client Validation:', dbReport.passed ? '✅ PASS' : '❌ FAIL')

    // Generate comprehensive CI report
    const ciReport = testAgent.generateCIReport()
    console.log('\n=== CI Report ===')
    console.log(`Total Spans: ${ciReport.totalSpans}`)
    console.log(`Integrations Tested: ${ciReport.overall.totalIntegrations}`)
    console.log(`Overall Success Rate: ${ciReport.overall.successRate}`)
  } catch (error) {
    console.error('Validation failed:', error.message)
  }
}

module.exports = {
  APMTestAgent,
  exampleTestSuite
}

// Run example if this file is executed directly
if (require.main === module) {
  exampleTestSuite().catch(console.error)
}
