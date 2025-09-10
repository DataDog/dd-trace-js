'use strict'

const { MCPClient } = require('../../../shared/mcp-client')
const { FILE_GENERATORS, INSERTION_POINTS } = require('../file-specifications')

/**
 * CI Workflow Generator
 * Updates .github/workflows/apm-integrations.yml with new test job
 */

async function updateCIWorkflow (repoRoot, integrationName, category) {
  const mcpClient = new MCPClient()
  await mcpClient.connect()

  try {
    const filePath = `${repoRoot}/.github/workflows/apm-integrations.yml`
    const content = await mcpClient.readFile(filePath)

    // Check if job already exists
    if (content.includes(`  ${integrationName}:`)) {
      console.log(`✓ CI workflow already includes ${integrationName} job`)
      return filePath
    }

    const jobContent = FILE_GENERATORS.generateCIJob(integrationName, category)
    const insertionPoint = INSERTION_POINTS.findCIInsertionPoint(content, integrationName)

    const lines = content.split('\n')
    const jobLines = jobContent.split('\n')

    // Insert the job at the correct alphabetical position
    lines.splice(insertionPoint.lineIndex, 0, ...jobLines)

    const newContent = lines.join('\n')
    await mcpClient.writeFile(filePath, newContent)

    console.log(`✓ Updated CI workflow: ${integrationName} job added`)
    return filePath
  } finally {
    await mcpClient.disconnect()
  }
}

module.exports = {
  updateCIWorkflow
}
