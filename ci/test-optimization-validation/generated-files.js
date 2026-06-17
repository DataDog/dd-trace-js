'use strict'

const fs = require('fs')
const path = require('path')

function writeGeneratedFiles (framework) {
  const strategy = framework.generatedTestStrategy
  if (!strategy || strategy.status !== 'verified') {
    return []
  }

  const written = []
  for (const file of strategy.files || []) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true })
    fs.writeFileSync(file.path, `${file.contentLines.join('\n')}\n`)
    written.push(file.path)
  }
  return written
}

function cleanupGeneratedFiles (manifest, { keep = false } = {}) {
  if (keep) return

  for (const framework of manifest.frameworks || []) {
    const strategy = framework.generatedTestStrategy
    for (const cleanupPath of strategy?.cleanupPaths || []) {
      try {
        fs.rmSync(cleanupPath, { force: true, recursive: true })
      } catch {
        // Cleanup should be best-effort. The report will contain the command artifacts.
      }
    }
  }
}

function cleanupGeneratedRuntimeFiles (framework) {
  const strategy = framework.generatedTestStrategy
  if (!strategy) return

  const generatedFiles = (strategy.files || []).map(file => path.resolve(file.path))
  for (const cleanupPath of strategy.cleanupPaths || []) {
    const resolvedCleanupPath = path.resolve(cleanupPath)
    if (containsGeneratedFile(resolvedCleanupPath, generatedFiles)) continue
    try {
      fs.rmSync(resolvedCleanupPath, { force: true, recursive: true })
    } catch {
      // Runtime cleanup should be best-effort. Feature validation will report missing events if reset failed.
    }
  }
}

function containsGeneratedFile (cleanupPath, generatedFiles) {
  return generatedFiles.some(file => {
    return file === cleanupPath || file.startsWith(`${cleanupPath}${path.sep}`)
  })
}

function findGeneratedScenario (framework, scenarioId) {
  return (framework.generatedTestStrategy?.scenarios || []).find(scenario => scenario.id === scenarioId)
}

module.exports = {
  cleanupGeneratedFiles,
  cleanupGeneratedRuntimeFiles,
  findGeneratedScenario,
  writeGeneratedFiles,
}
