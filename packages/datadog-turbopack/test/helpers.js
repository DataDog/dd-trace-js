'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { withDatadogTurbopack } = require('../../../next')

/** @type {string[]} */
const directories = []

/**
 * @param {object|Promise<object>|Function} [nextConfig]
 * @param {{ projectDir?: string }} [options]
 * @returns {Promise<object>}
 */
function applyDatadogTurbopack (nextConfig, options) {
  const wrapped = withDatadogTurbopack(nextConfig, options)
  return wrapped('phase-production-build')
}

/**
 * @param {string} [nextVersion]
 * @returns {string}
 */
function createProject (nextVersion = '16.0.0') {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-')))
  directories.push(directory)
  write(directory, 'package.json', '{}')
  const next = createPackage(directory, 'next', { main: 'index.js', version: nextVersion })
  write(next, 'index.js', 'module.exports = {}')
  const major = Number(nextVersion.split('.')[0])
  const findRoot = major >= 16
    ? 'exports.findRootDirAndLockFiles = cwd => ({ lockFiles: [], rootDir: cwd })\n'
    : 'exports.findRootDir = cwd => cwd\n'
  write(next, 'dist/lib/find-root.js', findRoot)
  for (const name of ['generator', 'parser', 'traverse']) {
    const modulePath = require.resolve(`@babel/${name}`)
    write(next, `dist/compiled/babel/${name}.js`, `module.exports = require(${JSON.stringify(modulePath)})\n`)
  }
  return directory
}

/**
 * @param {{ nextVersion?: string, source?: string }} [options]
 * @returns {{ packageDir: string, projectDir: string, resourcePath: string }}
 */
function createIoredisProject (options = {}) {
  const projectDir = createProject(options.nextVersion)
  const packageDir = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
  const resourcePath = write(packageDir, 'index.js', options.source ?? 'module.exports = {}')
  return { packageDir, projectDir, resourcePath }
}

/**
 * @param {string} projectDir
 * @param {string} name
 * @param {object} [manifest]
 * @returns {string}
 */
function createPackage (projectDir, name, manifest = {}) {
  const packageDirectory = path.join(projectDir, 'node_modules', name)
  fs.mkdirSync(packageDirectory, { recursive: true })
  fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ name, ...manifest }))
  return packageDirectory
}

/**
 * @param {string} directory
 * @param {string} relativePath
 * @param {string} content
 * @returns {string}
 */
function write (directory, relativePath, content) {
  const target = path.resolve(directory, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  return target
}

/**
 * @param {unknown} value
 * @returns {object[]}
 */
function findDatadogLoaders (value) {
  const loaders = []
  collectDatadogLoaders(value, loaders)
  return loaders
}

/**
 * @param {unknown} value
 * @param {object[]} loaders
 */
function collectDatadogLoaders (value, loaders) {
  if (Array.isArray(value)) {
    for (const item of value) collectDatadogLoaders(item, loaders)
    return
  }
  if (!value || typeof value !== 'object') return
  const candidate = /** @type {{ loader?: unknown, options?: unknown }} */ (value)
  if (typeof candidate.loader === 'string' && candidate.loader.includes('datadog-turbopack')) {
    loaders.push(value)
  }

  for (const key of Object.keys(value)) collectDatadogLoaders(value[key], loaders)
}

function cleanup () {
  while (directories.length > 0) {
    fs.rmSync(/** @type {string} */ (directories.pop()), { force: true, recursive: true })
  }
}

module.exports = {
  applyDatadogTurbopack,
  cleanup,
  createIoredisProject,
  createPackage,
  createProject,
  findDatadogLoaders,
  write,
}
