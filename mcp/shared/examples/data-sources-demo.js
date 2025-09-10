'use strict'

/**
 * Demo: Enhanced data source information in analysis reports
 *
 * This example shows how the enhanced data requirements system
 * provides detailed extraction guidance for developers.
 */

const { scoreDataAvailability } = require('./analyzer-integration')

/**
 * Demo function showing enhanced analysis with data source information
 */
function demonstrateDataSourceAnalysis () {
  console.log('=== Enhanced Data Source Analysis Demo ===\n')

  // Example targets from different integration types
  const targets = [
    {
      function_name: 'get',
      export_path: 'default',
      module: 'axios',
      type: 'http-client'
    },
    {
      function_name: 'query',
      export_path: 'default',
      module: 'mysql2',
      type: 'database-client'
    },
    {
      function_name: 'request',
      export_path: 'default',
      module: 'http',
      type: 'http-client'
    }
  ]

  targets.forEach((target, index) => {
    console.log(`--- Target ${index + 1}: ${target.module}.${target.function_name} ---`)

    const [category, subcategory] = target.type.split('-')
    const result = scoreDataAvailability(target, category, subcategory)

    console.log(`Overall Score: ${(result.score * 100).toFixed(1)}%`)
    console.log(`Integration Type: ${result.integrationType}`)
    console.log(`Reasoning: ${result.reasoning}\n`)

    // Show detailed data source information for each requirement level
    for (const [level, dataTypes] of Object.entries(result.breakdown)) {
      console.log(`${level.toUpperCase()} Data Requirements:`)

      for (const [dataType, info] of Object.entries(dataTypes)) {
        const status = info.available ? '✅' : '❌'
        console.log(`  ${status} ${dataType} (score: ${info.score.toFixed(2)})`)
        console.log(`      Span Fields: ${info.spanFields.join(', ')}`)
        console.log(`      Extraction: ${info.extractionGuide.primary}`)

        if (info.extractionGuide.alternatives.length > 0) {
          console.log('      Alternatives:')
          info.extractionGuide.alternatives.slice(0, 2).forEach(alt => {
            console.log(`        - ${alt.method}`)
          })
        }

        if (info.dataSources.length > 0) {
          console.log('      Example Code:')
          info.dataSources.slice(0, 1).forEach(source => {
            if (source.examples && source.examples.length > 0) {
              console.log(`        ${source.examples[0]}`)
            }
          })
        }
        console.log('')
      }
    }

    console.log('Expected Span Fields Summary:')
    Object.entries(result.expectedSpanFields).forEach(([field, info]) => {
      const required = info.required ? ' (REQUIRED)' : ''
      console.log(`  • ${field}: ${info.spanFields.join(', ')}${required}`)
    })

    console.log('\n' + '='.repeat(60) + '\n')
  })
}

/**
 * Generate instrumentation guidance based on data source analysis
 */
function generateInstrumentationGuidance (target, category, subcategory) {
  const result = scoreDataAvailability(target, category, subcategory)

  const guidance = {
    target: `${target.module}.${target.function_name}`,
    integrationType: result.integrationType,
    overallScore: result.score,
    instrumentationSteps: [],
    codeExamples: [],
    spanTags: {}
  }

  // Generate step-by-step instrumentation guidance
  for (const [level, dataTypes] of Object.entries(result.breakdown)) {
    for (const [dataType, info] of Object.entries(dataTypes)) {
      if (info.available) {
        guidance.instrumentationSteps.push({
          step: guidance.instrumentationSteps.length + 1,
          priority: level,
          dataType,
          instruction: info.extractionGuide.primary,
          spanFields: info.spanFields,
          complexity: info.extractionGuide.complexity
        })

        // Add span tag mapping
        info.spanFields.forEach(field => {
          guidance.spanTags[field] = {
            dataType,
            priority: level,
            extraction: info.extractionGuide.primary
          }
        })

        // Generate code examples
        if (info.dataSources.length > 0) {
          const source = info.dataSources[0]
          if (source.examples && source.examples.length > 0) {
            guidance.codeExamples.push({
              dataType,
              example: source.examples[0],
              description: source.description
            })
          }
        }
      }
    }
  }

  return guidance
}

/**
 * Demo the instrumentation guidance generation
 */
function demonstrateInstrumentationGuidance () {
  console.log('=== Instrumentation Guidance Generation ===\n')

  const target = {
    function_name: 'get',
    export_path: 'default',
    module: 'axios'
  }

  const guidance = generateInstrumentationGuidance(target, 'http', 'client')

  console.log(`Target: ${guidance.target}`)
  console.log(`Integration Type: ${guidance.integrationType}`)
  console.log(`Overall Score: ${(guidance.overallScore * 100).toFixed(1)}%\n`)

  console.log('Instrumentation Steps:')
  guidance.instrumentationSteps.forEach(step => {
    console.log(`${step.step}. [${step.priority.toUpperCase()}] ${step.dataType}`)
    console.log(`   ${step.instruction}`)
    console.log(`   → Span fields: ${step.spanFields.join(', ')}`)
    console.log(`   → Complexity: ${step.complexity}\n`)
  })

  console.log('Generated Code Examples:')
  guidance.codeExamples.forEach((example, index) => {
    console.log(`${index + 1}. ${example.dataType}:`)
    console.log(`   ${example.example}`)
    console.log(`   // ${example.description}\n`)
  })

  console.log('Span Tag Mapping:')
  Object.entries(guidance.spanTags).forEach(([tag, info]) => {
    console.log(`  span.setTag('${tag}', ${info.extraction})`)
    console.log(`    // ${info.dataType} (${info.priority})\n`)
  })
}

// Run demos if this file is executed directly
if (require.main === module) {
  demonstrateDataSourceAnalysis()
  demonstrateInstrumentationGuidance()
}

module.exports = {
  demonstrateDataSourceAnalysis,
  generateInstrumentationGuidance,
  demonstrateInstrumentationGuidance
}
