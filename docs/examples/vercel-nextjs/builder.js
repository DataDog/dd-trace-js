'use strict'

const fs = require('node:fs/promises')
const Module = require('node:module')
const path = require('node:path')

const DATADOG_PRELOAD = '--import=dd-trace/initialize.mjs'

function mergeNodeOptions (nodeOptions = '') {
  if (nodeOptions.includes('dd-trace/initialize.mjs')) return nodeOptions
  return `${DATADOG_PRELOAD} ${nodeOptions}`.trim()
}

async function findFunctionPaths (directory) {
  const functionPaths = []

  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue

    const entryPath = path.join(directory, entry.name)
    if (entry.name.endsWith('.func')) {
      functionPaths.push(entryPath)
    } else {
      functionPaths.push(...await findFunctionPaths(entryPath))
    }
  }

  return functionPaths
}

async function findPackageRoot (packageName, searchPath) {
  const packageRequire = Module.createRequire(path.join(searchPath, 'package.json'))
  let resolved

  try {
    resolved = packageRequire.resolve(`${packageName}/package.json`)
  } catch (error) {
    if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
    resolved = packageRequire.resolve(packageName)
  }

  let directory = path.dirname(resolved)

  while (directory !== path.dirname(directory)) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'))
      if (manifest.name === packageName) return directory
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    directory = path.dirname(directory)
  }

  throw new Error(`Unable to find the package root for ${packageName}`)
}

async function resolveTracerRoot () {
  return validateTracerRoot(await findPackageRoot('dd-trace', __dirname))
}

async function validateTracerRoot (tracerRoot) {
  const manifestPath = path.join(tracerRoot, 'package.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))

  if (manifest.name !== 'dd-trace') {
    throw new Error(`Expected ${manifestPath} to describe dd-trace`)
  }

  try {
    await fs.access(path.join(tracerRoot, 'initialize.mjs'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    throw new Error(
      `dd-trace ${manifest.version || 'unknown'} does not provide initialize.mjs; install a supported version`
    )
  }

  return tracerRoot
}

function findTraceBase (tracerRoot) {
  let directory = tracerRoot

  while (directory !== path.dirname(directory)) {
    if (path.join(directory, 'node_modules', 'dd-trace') === tracerRoot) return directory
    directory = path.dirname(directory)
  }

  throw new Error(`dd-trace must be installed under node_modules: ${tracerRoot}`)
}

async function stageTracerFiles (tracerRoot, workPath) {
  // eslint-disable-next-line import/no-extraneous-dependencies, n/no-extraneous-require -- Builder dependency.
  const { nodeFileTrace } = require('@vercel/nft')
  const traceBase = await fs.realpath(findTraceBase(tracerRoot))
  tracerRoot = await fs.realpath(tracerRoot)
  const manifest = JSON.parse(await fs.readFile(path.join(tracerRoot, 'package.json'), 'utf8'))
  const packageRequire = Module.createRequire(path.join(tracerRoot, 'package.json'))
  // The tracer loads vendored modules and features dynamically, so NFT alone
  // cannot discover its complete runtime.
  const packageFiles = await listPackageFiles(tracerRoot)
  const entrypoints = [path.join(tracerRoot, 'initialize.mjs')]

  for (const dependency of [
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.optionalDependencies || {}),
  ]) {
    try {
      entrypoints.push(packageRequire.resolve(dependency))
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error
    }
  }

  const { fileList } = await nodeFileTrace(entrypoints, {
    base: traceBase,
    processCwd: workPath,
  })
  for (const filePath of packageFiles) fileList.add(path.relative(traceBase, filePath))

  const runtimeRoot = path.join(workPath, '.datadog', 'vercel-runtime')
  const filePathMap = {}

  await fs.rm(runtimeRoot, { force: true, recursive: true })

  for (const relativePath of fileList) {
    const source = path.join(traceBase, relativePath)
    const destination = path.join(runtimeRoot, relativePath)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.copyFile(source, destination)
    filePathMap[toPosixPath(relativePath)] = toPosixPath(path.relative(workPath, destination))
  }

  return filePathMap
}

async function listPackageFiles (directory) {
  const files = []

  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listPackageFiles(entryPath))
    if (entry.isFile()) files.push(entryPath)
  }

  return files
}

function toPosixPath (filePath) {
  return filePath.split(path.sep).join('/')
}

async function instrumentBuildOutput (outputPath, tracerRoot, workPath) {
  const functionsPath = path.join(outputPath, 'functions')

  try {
    await fs.access(functionsPath)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }

  const functionPaths = await findFunctionPaths(functionsPath)
  const nodeFunctions = []

  for (const functionPath of functionPaths) {
    const configPath = path.join(functionPath, '.vc-config.json')
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
    if (!String(config.runtime).startsWith('nodejs')) continue

    nodeFunctions.push({ config, configPath })
  }

  if (nodeFunctions.length === 0) return

  const tracerFilePathMap = await stageTracerFiles(tracerRoot, workPath)

  for (const { config, configPath } of nodeFunctions) {
    config.filePathMap = {
      ...config.filePathMap,
      ...tracerFilePathMap,
    }
    config.environment = {
      ...config.environment,
      NODE_OPTIONS: mergeNodeOptions(config.environment?.NODE_OPTIONS),
    }
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  }
}

async function build (options) {
  // eslint-disable-next-line n/no-missing-require -- Declared by the published Builder package.
  const { build: buildNext } = require('@vercel/next')
  const result = await buildNext(options)

  if (result.buildOutputPath) {
    const tracerRoot = await resolveTracerRoot()
    await instrumentBuildOutput(result.buildOutputPath, tracerRoot, options.workPath)
  }

  return result
}

module.exports = {
  build,
  findTraceBase,
  instrumentBuildOutput,
  listPackageFiles,
  mergeNodeOptions,
  resolveTracerRoot,
  stageTracerFiles,
  validateTracerRoot,
}
