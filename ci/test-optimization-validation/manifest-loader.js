'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { validateManifest } = require('./manifest-schema')

const MAX_MANIFEST_BYTES = 5 * 1024 * 1024

function loadManifest (manifestPath) {
  const resolvedPath = path.resolve(manifestPath)
  const stat = fs.lstatSync(resolvedPath)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Validation manifest must be a regular file, not a symbolic link: ${resolvedPath}`)
  }
  if (stat.size > MAX_MANIFEST_BYTES) {
    throw new Error(`Validation manifest exceeds the ${MAX_MANIFEST_BYTES}-byte size limit: ${resolvedPath}`)
  }
  const raw = fs.readFileSync(resolvedPath, 'utf8')
  const manifest = JSON.parse(raw)
  manifest.__path = resolvedPath
  Object.defineProperty(manifest, '__sourceSha256', {
    configurable: false,
    enumerable: false,
    value: crypto.createHash('sha256').update(raw).digest('hex'),
    writable: false,
  })

  const errors = validateManifest(manifest)
  if (errors.length > 0) {
    throw new Error(`Invalid validation manifest:\n- ${errors.join('\n- ')}`)
  }
  if (path.dirname(resolvedPath) !== path.resolve(manifest.repository.root)) {
    throw new Error(`Validation manifest must be stored directly in repository.root: ${resolvedPath}`)
  }
  validatePhysicalManifestPaths(manifest)

  return manifest
}

function validatePhysicalManifestPaths (manifest) {
  const root = fs.realpathSync(manifest.repository.root)

  for (const [label, candidate] of getManifestPaths(manifest)) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue
    let existing = candidate
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing)
    const physical = fs.realpathSync(existing)
    if (!isPathInside(root, physical)) {
      throw new Error(`Validation manifest ${label} resolves outside repository.root: ${candidate}`)
    }
  }
}

function getManifestPaths (manifest) {
  const paths = []
  for (const [frameworkIndex, framework] of (manifest.frameworks || []).entries()) {
    const prefix = `frameworks[${frameworkIndex}]`
    paths.push(
      [`${prefix}.project.root`, framework.project?.root],
      [`${prefix}.project.packageJson`, framework.project?.packageJson],
      [`${prefix}.ciWiring.configFile`, framework.ciWiring?.configFile],
      [`${prefix}.ciWiring.workingDirectory`, framework.ciWiring?.workingDirectory]
    )
    for (const [index, configFile] of (framework.project?.configFiles || []).entries()) {
      paths.push([`${prefix}.project.configFiles[${index}]`, configFile])
    }
    for (const [name, command] of getCommands(framework)) {
      paths.push([`${prefix}.${name}.cwd`, command.cwd])
      for (const [outputIndex, outputPath] of (command.outputPaths || []).entries()) {
        paths.push([`${prefix}.${name}.outputPaths[${outputIndex}]`, outputPath])
      }
    }

    const strategy = framework.generatedTestStrategy
    paths.push([`${prefix}.generatedTestStrategy.testDirectory`, strategy?.testDirectory])
    for (const [index, file] of (strategy?.files || []).entries()) {
      paths.push([`${prefix}.generatedTestStrategy.files[${index}].path`, file.path])
    }
    for (const [index, cleanupPath] of (strategy?.cleanupPaths || []).entries()) {
      paths.push([`${prefix}.generatedTestStrategy.cleanupPaths[${index}]`, cleanupPath])
    }
    for (const [scenarioIndex, scenario] of (strategy?.scenarios || []).entries()) {
      for (const [identityIndex, identity] of (scenario?.testIdentities || []).entries()) {
        paths.push([
          `${prefix}.generatedTestStrategy.scenarios[${scenarioIndex}].testIdentities[${identityIndex}].file`,
          identity.file,
        ])
      }
    }
  }
  return paths
}

function getCommands (framework) {
  const commands = []
  for (const name of ['existingTestCommand', 'forcedLocalCommand', 'ciWiringCommand']) {
    if (framework[name]) commands.push([name, framework[name]])
  }
  for (const [index, command] of (framework.setup?.commands || []).entries()) {
    commands.push([`setup.commands[${index}]`, command])
  }
  for (const [index, scenario] of (framework.generatedTestStrategy?.scenarios || []).entries()) {
    if (scenario?.runCommand) {
      commands.push([`generatedTestStrategy.scenarios[${index}].runCommand`, scenario.runCommand])
    }
  }
  return commands
}

function isPathInside (root, filename) {
  const relative = path.relative(root, filename)
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

module.exports = { loadManifest }
