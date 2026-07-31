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

async function resolveTracerRoot (workPath) {
  try {
    return await findPackageRoot('dd-trace', workPath)
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    return findPackageRoot('dd-trace', __dirname)
  }
}

async function collectPackageGraph (tracerRoot) {
  const installationRoot = path.dirname(tracerRoot)
  const packages = new Map()
  const pending = [{ destination: 'dd-trace', name: 'dd-trace', root: tracerRoot, required: true }]

  while (pending.length > 0) {
    const current = pending.pop()
    let manifest

    try {
      manifest = JSON.parse(await fs.readFile(path.join(current.root, 'package.json'), 'utf8'))
    } catch (error) {
      if (!current.required && error.code === 'ENOENT') continue
      throw error
    }

    const existing = packages.get(current.destination)
    if (existing) {
      if (existing.root !== current.root) {
        throw new Error(
          `dd-trace dependency graph maps multiple packages to node_modules/${current.destination}`
        )
      }
      continue
    }

    packages.set(current.destination, { manifest, root: current.root })

    const dependencies = Object.keys(manifest.dependencies || {})
    const optionalDependencies = Object.keys(manifest.optionalDependencies || {})

    for (const name of dependencies) {
      const root = await findPackageRoot(name, current.root)
      const destination = tracerDependencyDestination(name, root, installationRoot)
      pending.push({ destination, name, root, required: true })
    }
    for (const name of optionalDependencies) {
      try {
        const root = await findPackageRoot(name, current.root)
        pending.push({
          destination: tracerDependencyDestination(name, root, installationRoot),
          name,
          root,
          required: false,
        })
      } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error
      }
    }
  }

  return packages
}

function tracerDependencyDestination (name, packageRoot, installationRoot) {
  const destination = packageDestination(name, packageRoot, installationRoot)
  return path.join('dd-trace', 'node_modules', destination)
}

function packageDestination (name, packageRoot, installationRoot) {
  const relativePath = path.relative(installationRoot, packageRoot)
  if (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath)) {
    return relativePath
  }
  return name
}

async function stagePackageGraph (packages, workPath) {
  const runtimeRoot = path.join(workPath, '.datadog', 'vercel-runtime', 'node_modules')
  const filePathMap = {}

  await fs.rm(runtimeRoot, { force: true, recursive: true })

  for (const [destinationPath, packageInfo] of packages) {
    const destination = path.join(runtimeRoot, destinationPath)
    await fs.cp(packageInfo.root, destination, {
      recursive: true,
      dereference: true,
      filter: source => {
        const relativePath = path.relative(packageInfo.root, source)
        return relativePath === '' || relativePath.split(path.sep)[0] !== 'node_modules'
      },
    })

    for (const filePath of await listFiles(destination)) {
      const functionPath = path.join('node_modules', destinationPath, path.relative(destination, filePath))
      filePathMap[toPosixPath(functionPath)] = toPosixPath(path.relative(workPath, filePath))
    }
  }

  return filePathMap
}

async function listFiles (directory) {
  const files = []

  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listFiles(entryPath))
    } else if (entry.isFile()) {
      files.push(entryPath)
    }
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

  const packageGraph = await collectPackageGraph(tracerRoot)
  const tracerFilePathMap = await stagePackageGraph(packageGraph, workPath)

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
    const tracerRoot = await resolveTracerRoot(options.workPath)
    await instrumentBuildOutput(result.buildOutputPath, tracerRoot, options.workPath)
  }

  return result
}

module.exports = {
  build,
  collectPackageGraph,
  instrumentBuildOutput,
  mergeNodeOptions,
  resolveTracerRoot,
}
