'use strict'

const { MCPClient } = require('../../../shared/mcp-client')
const { FILE_GENERATORS, INSERTION_POINTS } = require('../file-specifications')

/**
 * Documentation File Generators
 * Updates all documentation files required for an integration
 */

async function updateDocumentationFiles (repoRoot, integrationName, packageName, analysis) {
  const mcpClient = new MCPClient()
  await mcpClient.connect()

  try {
    const results = []

    // 1. Update API documentation
    results.push(await updateAPIDocs(mcpClient, repoRoot, integrationName))

    // 2. Update redirect script
    results.push(await updateRedirectScript(mcpClient, repoRoot, integrationName))

    // 3. Update TypeScript test definitions
    results.push(await updateTestDefinitions(mcpClient, repoRoot, integrationName))

    // 4. Update main TypeScript definitions
    results.push(await updateMainTypeDefinitions(mcpClient, repoRoot, integrationName, packageName, analysis.category))

    return results
  } finally {
    await mcpClient.disconnect()
  }
}

async function updateAPIDocs (mcpClient, repoRoot, integrationName) {
  const filePath = `${repoRoot}/docs/API.md`
  const content = await mcpClient.readFile(filePath)

  // Check if already exists
  if (content.includes(`<h5 id="${integrationName}"></h5>`)) {
    console.log(`✓ API docs already include ${integrationName}`)
    return filePath
  }

  const anchor = FILE_GENERATORS.generateAPIAnchor(integrationName)
  const pluginListEntry = FILE_GENERATORS.generateAPIPluginListEntry(integrationName)
  const insertionPoints = INSERTION_POINTS.findAPIDocsInsertionPoints(content, integrationName)

  const lines = content.split('\n')

  // Insert in reverse order to maintain line indices
  // 1. Insert plugin list entry
  lines.splice(insertionPoints.pluginList.lineIndex, 0, pluginListEntry)

  // 2. Insert h5 anchor (adjust line index since we added a line above)
  const adjustedH5Index = insertionPoints.h5Anchor.lineIndex < insertionPoints.pluginList.lineIndex
    ? insertionPoints.h5Anchor.lineIndex
    : insertionPoints.h5Anchor.lineIndex + 1
  lines.splice(adjustedH5Index, 0, anchor)

  const newContent = lines.join('\n')
  await mcpClient.writeFile(filePath, newContent)

  console.log(`✓ Updated API docs: ${integrationName} (anchor + plugin list)`)
  return filePath
}

async function updateRedirectScript (mcpClient, repoRoot, integrationName) {
  const filePath = `${repoRoot}/docs/add-redirects.sh`
  const content = await mcpClient.readFile(filePath)

  // Check if already exists
  if (content.includes(`"${integrationName}"`)) {
    console.log(`✓ Redirect script already includes ${integrationName}`)
    return filePath
  }

  const entry = FILE_GENERATORS.generateRedirectEntry(integrationName)
  const insertionPoint = INSERTION_POINTS.findRedirectInsertionPoint(content, integrationName)

  const lines = content.split('\n')
  lines.splice(insertionPoint.lineIndex, 0, entry)

  const newContent = lines.join('\n')
  await mcpClient.writeFile(filePath, newContent)

  console.log(`✓ Updated redirect script: ${integrationName}`)
  return filePath
}

async function updateTestDefinitions (mcpClient, repoRoot, integrationName) {
  const filePath = `${repoRoot}/docs/test.ts`
  const content = await mcpClient.readFile(filePath)

  // Check if already exists
  if (content.includes(`tracer.use('${integrationName}');`)) {
    console.log(`✓ Test definitions already include ${integrationName}`)
    return filePath
  }

  const usage = FILE_GENERATORS.generateTestUsage(integrationName)
  const insertionPoint = INSERTION_POINTS.findTestInsertionPoint(content, integrationName)

  const lines = content.split('\n')
  lines.splice(insertionPoint.lineIndex, 0, usage)

  const newContent = lines.join('\n')
  await mcpClient.writeFile(filePath, newContent)

  console.log(`✓ Updated test definitions: ${integrationName}`)
  return filePath
}

async function updateMainTypeDefinitions (mcpClient, repoRoot, integrationName, packageName, category) {
  const filePath = `${repoRoot}/index.d.ts`
  const content = await mcpClient.readFile(filePath)

  const interfaceKey = integrationName.replace(/-/g, '_')

  // Check if already exists
  if (content.includes(`"${integrationName}": tracer.plugins.${interfaceKey};`)) {
    console.log(`✓ TypeScript definitions already include ${integrationName}`)
    return filePath
  }

  const interfaces = FILE_GENERATORS.generateTypeScriptInterfaces(integrationName, category, packageName)
  const insertionPoints = INSERTION_POINTS.findTypeScriptInsertionPoints(content, integrationName)

  const lines = content.split('\n')

  // Insert in reverse order to maintain line indices
  if (insertionPoints.tracerNamespace) {
    // Insert interface definition in tracer namespace
    const interfaceLines = interfaces.tracerNamespace.split('\n')
    lines.splice(insertionPoints.tracerNamespace.lineIndex, 0, ...interfaceLines, '')
  }

  if (insertionPoints.pluginsInterface) {
    // Insert plugin interface entry
    lines.splice(insertionPoints.pluginsInterface.lineIndex, 0, interfaces.pluginsInterface)
  }

  const newContent = lines.join('\n')
  await mcpClient.writeFile(filePath, newContent)

  console.log(`✓ Updated TypeScript definitions: ${integrationName}`)
  return filePath
}

module.exports = {
  updateDocumentationFiles,
  updateAPIDocs,
  updateRedirectScript,
  updateTestDefinitions,
  updateMainTypeDefinitions
}
