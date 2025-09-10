'use strict'

const { MCPClient } = require('../../../shared/mcp-client')
const { FILE_GENERATORS, INSERTION_POINTS } = require('../file-specifications')

/**
 * Hooks Registry Generator
 * Updates packages/datadog-instrumentations/src/helpers/hooks.js
 */

async function updateHooksRegistry (repoRoot, integrationName) {
  const mcpClient = new MCPClient()
  await mcpClient.connect()

  try {
    const filePath = `${repoRoot}/packages/datadog-instrumentations/src/helpers/hooks.js`
    const content = await mcpClient.readFile(filePath)

    // Check if hook already exists
    if (content.includes(`${integrationName}: () => require('../${integrationName}')`)) {
      console.log(`✓ Hooks registry already includes ${integrationName}`)
      return filePath
    }

    const hookEntry = FILE_GENERATORS.generateHooksEntry(integrationName)
    const insertionPoint = INSERTION_POINTS.findHooksInsertionPoint(content, integrationName)

    const lines = content.split('\n')
    lines.splice(insertionPoint.lineIndex, 0, hookEntry)

    const newContent = lines.join('\n')
    await mcpClient.writeFile(filePath, newContent)

    console.log(`✓ Updated hooks registry: ${integrationName}`)
    return filePath
  } finally {
    await mcpClient.disconnect()
  }
}

module.exports = {
  updateHooksRegistry
}
