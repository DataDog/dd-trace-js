'use strict'

const { execFile } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')

const NYC = require('nyc')

const baseConfig = require('../../nyc.config')
const { PRE_INSTRUMENTED_ROOT, PRE_INSTRUMENTED_SENTINEL, REPO_ROOT, scriptLabel } = require('./runtime')

const execFileAsync = promisify(execFile)

const TARBALL_PACKAGE_DIR = 'package'
const BUN = path.join(REPO_ROOT, 'node_modules', '.bin', 'bun')
const MAX_BUFFER = 64 * 1024 * 1024
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const INSTRUMENT_CONCURRENCY = Math.max(2, Math.min(os.availableParallelism?.() ?? os.cpus().length, 12))

// `nyc/lib/instrumenters/istanbul.js` destructures this 3rd arg.
const NO_SOURCE_MAP = { sourceMap: undefined, registerMap () {} }

/**
 * @returns {string}
 */
function createStagingDir () {
  const label = scriptLabel() || 'default'
  const suffix = `${process.pid}-${Date.now().toString(36)}`
  return path.join(os.tmpdir(), `dd-trace-coverage-staging-${label}-${suffix}`)
}

/**
 * @param {string} tarballPath
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<void>}
 */
async function runBunPack (tarballPath, env) {
  await execFileAsync(
    BUN,
    ['pm', 'pack', '--ignore-scripts', '--quiet', '--gzip-level', '0', '--filename', tarballPath],
    { env, maxBuffer: MAX_BUFFER },
  )
}

/**
 * @param {string} archive
 * @param {string} destination
 * @returns {Promise<void>}
 */
async function extractTarball (archive, destination) {
  await fs.mkdir(destination, { recursive: true })
  await execFileAsync('tar', ['-xzf', archive, '-C', destination], { maxBuffer: MAX_BUFFER })
}

/**
 * @param {string} sourceDir
 * @param {string} archive
 * @returns {Promise<void>}
 */
async function repackTarball (sourceDir, archive) {
  await execFileAsync(
    'tar',
    ['-czf', archive, '-C', path.dirname(sourceDir), path.basename(sourceDir)],
    { maxBuffer: MAX_BUFFER },
  )
}

/**
 * @param {NYC} nyc
 * @param {string} packageDir
 * @param {string} relPath
 * @returns {Promise<void>}
 */
async function instrumentOne (nyc, packageDir, relPath) {
  const diskPath = path.join(packageDir, relPath)
  const source = await fs.readFile(diskPath, 'utf8')
  const placeholderPath = `${PRE_INSTRUMENTED_ROOT}/${relPath.replaceAll(path.sep, '/')}`

  let instrumented
  try {
    instrumented = nyc.instrumenter().instrumentSync(source, placeholderPath, NO_SOURCE_MAP)
  } catch (err) {
    throw new Error(`Failed to instrument ${relPath}`, { cause: err })
  }
  await fs.writeFile(diskPath, instrumented)
}

/**
 * @param {string} packageDir
 * @returns {Promise<number>}
 */
async function instrumentPackage (packageDir) {
  const nyc = new NYC({
    ...baseConfig,
    cwd: packageDir,
    extension: ['.js', '.mjs'],
    esModules: true,
    sourceMap: false,
    cache: false,
    // Without this babel emits non-compact output, blowing up bundled files ~80x in lines.
    compact: true,
  })

  const files = await nyc.exclude.glob(packageDir)
  let nextIndex = 0
  async function worker () {
    while (true) {
      const i = nextIndex++
      if (i >= files.length) return
      await instrumentOne(nyc, packageDir, files[i])
    }
  }
  const workers = []
  for (let i = 0; i < INSTRUMENT_CONCURRENCY; i++) workers.push(worker())
  await Promise.all(workers)
  return files.length
}

/**
 * @param {string} packageDir
 * @param {number} instrumentedCount
 * @returns {Promise<void>}
 */
async function writeSentinel (packageDir, instrumentedCount) {
  const payload = {
    generatedAt: new Date().toISOString(),
    preInstrumentedRoot: PRE_INSTRUMENTED_ROOT,
    instrumentedFileCount: instrumentedCount,
    include: baseConfig.include,
    exclude: baseConfig.exclude,
  }
  await fs.writeFile(path.join(packageDir, PRE_INSTRUMENTED_SENTINEL), JSON.stringify(payload, null, 2))
}

/**
 * @param {string} tarballPath
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<void>}
 */
async function packInstrumentedTarball (tarballPath, env) {
  const staging = createStagingDir()
  const scratchTarball = path.join(staging, 'source.tgz')
  const packageDir = path.join(staging, TARBALL_PACKAGE_DIR)

  await fs.mkdir(staging, { recursive: true })
  try {
    await runBunPack(scratchTarball, env)
    await extractTarball(scratchTarball, staging)
    const instrumentedCount = await instrumentPackage(packageDir)
    await writeSentinel(packageDir, instrumentedCount)
    await repackTarball(packageDir, tarballPath)
  } finally {
    await fs.rm(staging, { force: true, recursive: true }).catch(() => {})
  }
}

module.exports = { packInstrumentedTarball }
