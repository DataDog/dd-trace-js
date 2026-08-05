'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

const INSTRUMENTATION_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx']
const DATADOG_PRELOAD = '--import=dd-trace/initialize.mjs'
const INSTRUMENTATION_SOURCE = `export function register () {
  if (process.env.NEXT_RUNTIME !== 'edge') {
    require('dd-trace/init')
  }
}
`

function getProjectPath (directory, fileName) {
  return directory === '.' ? fileName : path.posix.join(directory, fileName)
}

function getInstrumentationPaths (directory) {
  const paths = []

  for (const extension of INSTRUMENTATION_EXTENSIONS) {
    paths.push(getProjectPath(directory, `instrumentation.${extension}`))
    paths.push(getProjectPath(path.posix.join(directory, 'src'), `instrumentation.${extension}`))
  }

  return paths
}

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

function createBuildFile (FileBlob, data) {
  return new FileBlob({ data, contentType: 'application/javascript' })
}

function prepareBuildInput (options, FileBlob) {
  const directory = path.posix.dirname(options.entrypoint)

  const existingInstrumentation = getInstrumentationPaths(directory).find(filePath => options.files[filePath])
  if (existingInstrumentation) {
    throw new Error(
      `Cannot add Datadog instrumentation because ${existingInstrumentation} already exists. ` +
      'Add dd-trace/init to that file instead.'
    )
  }

  options.files[getProjectPath(directory, 'instrumentation.ts')] = createBuildFile(FileBlob, INSTRUMENTATION_SOURCE)
}

async function instrumentBuildOutput (outputPath) {
  const functionsPath = path.join(outputPath, 'functions')

  try {
    await fs.access(functionsPath)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }

  for (const functionPath of await findFunctionPaths(functionsPath)) {
    const configPath = path.join(functionPath, '.vc-config.json')
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
    if (!String(config.runtime).startsWith('nodejs')) continue

    config.environment = {
      ...config.environment,
      NODE_OPTIONS: mergeNodeOptions(config.environment?.NODE_OPTIONS),
    }
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  }
}

async function build (options) {
  // eslint-disable-next-line n/no-missing-require -- Declared by the published Builder package.
  const { FileBlob } = require('@vercel/build-utils')
  // eslint-disable-next-line n/no-missing-require -- Declared by the published Builder package.
  const { build: buildNext } = require('@vercel/next')

  prepareBuildInput(options, FileBlob)
  const result = await buildNext(options)

  if (result.buildOutputPath) await instrumentBuildOutput(result.buildOutputPath)

  return result
}

module.exports = {
  build,
  getInstrumentationPaths,
  instrumentBuildOutput,
  mergeNodeOptions,
  prepareBuildInput,
}
