'use strict'

const fs = require('fs').promises
const path = require('path')
const { generateMessagingPlugin, generateProducerPlugin, generateConsumerPlugin } = require('../templates/messaging')
const {
  generateWebServerTestSetup,
  generateDatabaseTestSetup,
  generateMessagingTestSetup,
  generateHttpClientTestSetup,
  generateGenericTestSetup
} = require('../templates/test-scenarios')

/**
 * Creates plugin package directory and files
 * Copied and simplified from original scaffolder
 */
async function createPluginPackage (repoRoot, integrationId, packageName, analysis) {
  const pluginDir = path.join(repoRoot, 'packages', `datadog-plugin-${integrationId}`)

  // Create directory structure
  await fs.mkdir(pluginDir, { recursive: true })
  await fs.mkdir(path.join(pluginDir, 'src'), { recursive: true })
  await fs.mkdir(path.join(pluginDir, 'test'), { recursive: true })
  await fs.mkdir(path.join(pluginDir, 'test', 'scenarios'), { recursive: true })

  // Generate files
  // Only create necessary files (src/ and test/ directories like existing plugins)
  const files = [
    {
      path: path.join(pluginDir, 'src', 'index.js'),
      content: generatePluginIndex(integrationId, packageName, analysis)
    },
    {
      path: path.join(pluginDir, 'test', 'index.spec.js'),
      content: generateTestFile(integrationId, packageName, analysis)
    },
    {
      path: path.join(pluginDir, 'test', 'scenarios', 'test-setup.js'),
      content: generateTestSetup(integrationId, packageName, analysis)
    }
  ]

  // Add producer and consumer files for messaging category
  if (analysis.category === 'messaging') {
    files.push(
      {
        path: path.join(pluginDir, 'src', 'producer.js'),
        content: generateProducerPlugin(integrationId)
      },
      {
        path: path.join(pluginDir, 'src', 'consumer.js'),
        content: generateConsumerPlugin(integrationId)
      }
    )
  }

  for (const file of files) {
    await fs.writeFile(file.path, file.content)
    console.log(`✓ Created: ${path.relative(repoRoot, file.path)}`)
  }

  return pluginDir
}

function generatePluginIndex (integrationId, packageName, analysis) {
  const className = integrationId.split('-').map(part =>
    part.charAt(0).toUpperCase() + part.slice(1)
  ).join('')

  // Category-aware plugin generation
  if (analysis.category === 'messaging') {
    return generateMessagingPlugin(integrationId, analysis)
  }

  // Default to TracingPlugin for other categories
  return `'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class ${className}Plugin extends TracingPlugin {
  static get id () {
    return '${integrationId}'
  }

  static get operation () {
    return 'request'
  }

  // TODO: Implement plugin-specific tracing logic for ${analysis.category}
  // TODO: Add span creation and tagging
  // TODO: Handle errors and edge cases
}

module.exports = ${className}Plugin
`
}

function generateTestFile (integrationId, packageName, analysis) {
  const category = analysis.category || 'library'
  const helperClass = getTestHelperClass(category)
  const setupClass = `${integrationId.charAt(0).toUpperCase() + integrationId.slice(1)}TestSetup`

  return `'use strict'

const { ${helperClass} } = require('../../dd-trace/test/setup/integration-test-helper')
const { ${setupClass} } = require('./scenarios/test-setup')

// Create test suite using the simplified helper approach
const testHelper = new ${helperClass}('${integrationId}', '${packageName}', ${setupClass})
testHelper.createTestSuite()
`
}

function getTestHelperClass (category) {
  switch (category) {
    case 'web':
    case 'http-server':
      return 'WebServerTestHelper'
    case 'database':
    case 'cache':
      return 'DatabaseTestHelper'
    case 'messaging':
      return 'MessagingTestHelper'
    default:
      return 'IntegrationTestHelper'
  }
}

function generateTestSetup (integrationId, packageName, analysis) {
  const category = analysis.category || 'library'

  switch (category) {
    case 'web':
    case 'http-server':
      return generateWebServerTestSetup(integrationId, packageName)
    case 'database':
    case 'cache':
      return generateDatabaseTestSetup(integrationId, packageName)
    case 'messaging':
      return generateMessagingTestSetup(integrationId, packageName)
    case 'http-client':
      return generateHttpClientTestSetup(integrationId, packageName)
    default:
      return generateGenericTestSetup(integrationId, packageName)
  }
}

module.exports = { createPluginPackage }
