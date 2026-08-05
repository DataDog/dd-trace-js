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

async function readBuildFile (file) {
  const chunks = []

  for await (const chunk of file.toStream()) chunks.push(chunk)

  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

function createBuildFile (FileBlob, data) {
  return new FileBlob({ data, contentType: 'application/javascript' })
}

function hasFrozenInstallCommand (installCommand) {
  return /\bnpm\s+ci\b|--frozen-lockfile|--immutable/.test(installCommand || '')
}

async function prepareBuildInput (options, tracerVersion, FileBlob) {
  const directory = path.posix.dirname(options.entrypoint)
  const packagePath = getProjectPath(directory, 'package.json')
  const packageFile = options.files[packagePath]

  if (!packageFile) throw new Error(`Expected ${packagePath} in the Vercel build input`)

  const existingInstrumentation = getInstrumentationPaths(directory).find(filePath => options.files[filePath])
  if (existingInstrumentation) {
    throw new Error(
      `Cannot add Datadog instrumentation because ${existingInstrumentation} already exists. ` +
      'Add dd-trace/init to that file instead.'
    )
  }

  const packageJson = JSON.parse(await readBuildFile(packageFile))
  const dependencies = { ...packageJson.dependencies }
  const developmentDependency = packageJson.devDependencies?.['dd-trace']

  if (hasFrozenInstallCommand(options.config?.installCommand) && !dependencies['dd-trace']) {
    throw new Error(
      'Cannot add dd-trace with a frozen install command. ' +
        'Add dd-trace to production dependencies and update the lockfile.'
    )
  }

  dependencies['dd-trace'] = dependencies['dd-trace'] || developmentDependency || tracerVersion

  if (developmentDependency) {
    const { 'dd-trace': ignored, ...devDependencies } = packageJson.devDependencies
    packageJson.devDependencies = devDependencies
  }

  packageJson.dependencies = dependencies
  options.files[packagePath] = createBuildFile(FileBlob, `${JSON.stringify(packageJson, null, 2)}\n`)
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
  // eslint-disable-next-line import/no-extraneous-dependencies, n/no-extraneous-require -- Builder dependency.
  const { version } = require('dd-trace/package.json')

  await prepareBuildInput(options, version, FileBlob)
  const result = await buildNext(options)

  if (result.buildOutputPath) await instrumentBuildOutput(result.buildOutputPath)

  return result
}

module.exports = {
  build,
  getInstrumentationPaths,
  hasFrozenInstallCommand,
  instrumentBuildOutput,
  mergeNodeOptions,
  prepareBuildInput,
}
