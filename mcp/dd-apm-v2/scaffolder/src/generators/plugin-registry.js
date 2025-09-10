'use strict'

const fs = require('fs').promises
const path = require('path')

/**
 * Updates packages/dd-trace/src/plugins/index.js to register new plugin
 * Copied and cleaned from original scaffolder
 */
async function updatePluginRegistry (repoRoot, integrationId, packageName) {
  const file = path.join(repoRoot, 'packages', 'dd-trace', 'src', 'plugins', 'index.js')

  if (!await fileExists(file)) {
    console.warn(`⚠️  Plugin registry not found: ${file}`)
    return
  }

  const src = await fs.readFile(file, 'utf8')

  // Check if already registered
  if (src.includes(`get '${packageName}'`)) {
    console.log(`✓ Plugin already registered: ${packageName}`)
    return
  }

  // Find module.exports object boundaries
  const start = src.indexOf('module.exports = {')
  const end = src.lastIndexOf('}')

  if (start === -1 || end === -1 || end <= start) {
    console.warn('⚠️  Could not parse plugin registry structure')
    return
  }

  const before = src.slice(0, start)
  const inner = src.slice(start + 'module.exports = {'.length, end)
  const after = src.slice(end)

  // Parse existing getters to find insertion point
  const lines = inner.split('\n')
  const getters = []

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]
    const match = line.match(/^\s*get\s+([^\s]+)\s*\(\)\s*\{\s*return\s+require\(([^)]+)\)\s*\}\s*,?\s*$/)
    if (match) {
      getters.push({
        idx,
        rawKey: match[1],
        req: match[2],
        normalizedKey: match[1].replace(/^["']|["']$/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
      })
    }
  }

  // Find where to insert (alphabetically)
  const targetNorm = packageName.toLowerCase()
  let insertIdx = -1

  for (const getter of getters) {
    if (getter.normalizedKey > targetNorm) {
      insertIdx = getter.idx
      break
    }
  }

  // Create new getter line
  const newGetter = `  get '${packageName}' () { return require('../../../datadog-plugin-${integrationId}/src') },`

  if (insertIdx === -1) {
    // Insert at end
    lines.push(newGetter)
  } else {
    // Insert at specific position
    lines.splice(insertIdx, 0, newGetter)
  }

  // Rebuild file
  const newContent = before + 'module.exports = {' + lines.join('\n') + after
  await fs.writeFile(file, newContent)

  console.log(`✓ Updated plugin registry: ${packageName}`)
}

async function fileExists (filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

module.exports = { updatePluginRegistry }
