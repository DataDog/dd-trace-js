#!/usr/bin/env node
'use strict'

/**
 * APM Test Generator v2
 *
 * Purpose: Generate realistic test scenarios that exercise real package APIs
 * Input: Analysis JSON + package documentation/examples
 * Output: Working test cases with actual API usage
 *
 * Design Principles:
 * - Test-first development: tests define expected behavior
 * - Real API usage: no mocks, actual package calls
 * - Clear validation: specific span assertions
 * - Incremental: start simple, add complexity
 */

const fs = require('fs').promises
const path = require('path')

class TestGenerator {
  constructor () {
    this.analysis = null
    this.scenarios = []
  }

  async generate (analysisFile, integrationName) {
    console.log(`🧪 Generating test scenarios for: ${integrationName}`)

    try {
      await this.loadAnalysis(analysisFile)
      await this.generateScenarios(integrationName)
      await this.writeTestFile(integrationName)

      console.log(`✅ Generated ${this.scenarios.length} test scenarios`)
    } catch (error) {
      console.error('❌ Test generation failed:', error.message)
      throw error
    }
  }

  async loadAnalysis (analysisFile) {
    const content = await fs.readFile(analysisFile, 'utf8')
    this.analysis = JSON.parse(content)
  }

  async generateScenarios (integrationName) {
    const { category, methods, package: pkg } = this.analysis

    // Generate category-specific scenarios
    switch (category) {
      case 'database':
        this.scenarios = this.generateDatabaseScenarios(pkg, methods)
        break
      case 'web':
        this.scenarios = this.generateWebScenarios(pkg, methods)
        break
      case 'messaging':
        this.scenarios = this.generateMessagingScenarios(pkg, methods)
        break
      default:
        this.scenarios = this.generateGenericScenarios(pkg, methods)
    }
  }

  generateDatabaseScenarios (pkg, methods) {
    return [
      {
        name: 'basic connection',
        description: 'Should establish database connection and create connection span',
        setup: 'const client = new mod.Client({ /* connection config */ })',
        action: 'await client.connect()',
        assertions: [
          'expect(spans).to.have.length(1)',
          `expect(spans[0].name).to.equal('${pkg.name}.connect')`,
          'expect(spans[0].resource).to.exist'
        ]
      },
      {
        name: 'query execution',
        description: 'Should execute query and create query span with SQL resource',
        setup: `const client = new mod.Client({ /* config */ })
        await client.connect()`,
        action: 'const result = await client.query(\'SELECT 1\')',
        assertions: [
          'expect(spans).to.have.length(1)',
          `expect(spans[0].name).to.equal('${pkg.name}.query')`,
          'expect(spans[0].resource).to.equal(\'SELECT 1\')',
          'expect(spans[0].meta[\'db.statement\']).to.equal(\'SELECT 1\')'
        ]
      },
      {
        name: 'error handling',
        description: 'Should create error span when query fails',
        setup: `const client = new mod.Client({ /* config */ })
        await client.connect()`,
        action: 'try { await client.query(\'INVALID SQL\') } catch (e) {}',
        assertions: [
          'expect(spans).to.have.length(1)',
          'expect(spans[0].error).to.equal(1)',
          'expect(spans[0].meta[\'error.message\']).to.exist'
        ]
      }
    ]
  }

  generateWebScenarios (pkg, methods) {
    return [
      {
        name: 'HTTP request',
        description: 'Should create HTTP request span',
        setup: 'const app = mod()',
        action: `app.get('/', (req, res) => res.send('ok'))
        const response = await request(app).get('/')`,
        assertions: [
          'expect(spans).to.have.length(1)',
          'expect(spans[0].name).to.equal(\'web.request\')',
          'expect(spans[0].meta[\'http.method\']).to.equal(\'GET\')'
        ]
      }
    ]
  }

  generateMessagingScenarios (pkg, methods) {
    return [
      {
        name: 'message publish',
        description: 'Should create producer span for message publishing',
        setup: 'const client = new mod.Client()',
        action: 'await client.publish(\'test-topic\', { message: \'hello\' })',
        assertions: [
          'expect(spans).to.have.length(1)',
          `expect(spans[0].name).to.equal('${pkg.name}.publish')`,
          'expect(spans[0].meta[\'messaging.destination\']).to.equal(\'test-topic\')'
        ]
      }
    ]
  }

  generateGenericScenarios (pkg, methods) {
    return [
      {
        name: 'basic operation',
        description: 'Should instrument main package operations',
        setup: 'const instance = new mod()',
        action: `const result = instance.${methods[0] || 'operation'}()`,
        assertions: [
          'expect(spans).to.have.length(1)',
          `expect(spans[0].name).to.match(/^${pkg.name}\\./)`
        ]
      }
    ]
  }

  async writeTestFile (integrationName) {
    const testContent = this.generateTestFileContent(integrationName)
    const testFile = `${integrationName}-test-scenarios.js`

    await fs.writeFile(testFile, testContent)
    console.log(`📝 Test scenarios written to: ${testFile}`)
  }

  generateTestFileContent (integrationName) {
    const pkg = this.analysis.package

    return `'use strict'

/**
 * ${pkg.name} Test Scenarios
 * Generated by dd-apm-test-generator
 * 
 * These are realistic test scenarios that should pass once
 * the instrumentation is properly implemented.
 */

const { expect } = require('chai')
const agent = require('../../dd-trace/test/plugins/agent')

describe('${pkg.name} Integration', () => {
  let mod, spans

  beforeEach(async () => {
    mod = require('${pkg.name}')
    spans = []
    
    // Capture spans for validation
    agent.use(traces => {
      spans = traces[0] || []
    })
  })

  ${this.scenarios.map(scenario => this.generateTestCase(scenario)).join('\n\n  ')}
})

// Helper functions for common test patterns
function expectSpan(name, resource) {
  expect(spans).to.have.length.greaterThan(0)
  const span = spans.find(s => s.name === name)
  expect(span, \`Expected span with name '\${name}'\`).to.exist
  if (resource) {
    expect(span.resource).to.equal(resource)
  }
  return span
}

function expectNoErrors() {
  spans.forEach(span => {
    expect(span.error).to.not.equal(1)
  })
}`
  }

  generateTestCase (scenario) {
    return `it('${scenario.name}', async () => {
    // ${scenario.description}
    
    // Setup
    ${scenario.setup}
    
    // Action that should create spans
    ${scenario.action}
    
    // Wait for spans to be recorded
    await new Promise(resolve => setTimeout(resolve, 10))
    
    // Assertions
    ${scenario.assertions.join('\n    ')}
  })`
  }
}

// CLI Interface
async function main () {
  const analysisFile = process.argv[2]
  const integrationName = process.argv[3]

  if (!analysisFile || !integrationName) {
    console.error('Usage: dd-test-gen <analysis.json> <integration-name>')
    process.exit(1)
  }

  try {
    const generator = new TestGenerator()
    await generator.generate(analysisFile, integrationName)
  } catch (error) {
    console.error('❌ Test generation failed:', error.message)
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}

module.exports = { TestGenerator }
