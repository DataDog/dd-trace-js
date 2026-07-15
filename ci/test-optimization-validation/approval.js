'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { getCommandOutputPaths } = require('./command-output-policy')
const { getCommandExecutionSettings } = require('./command-runner')
const { bindManifestExecutables, getManifestCommands } = require('./executable')
const { getFixtureRecipeDigests } = require('./offline-fixtures')
const { sanitizeForReport } = require('./redaction')

const APPROVAL_DIGEST_PATTERN = /^[a-f0-9]{64}$/
const OFFLINE_FIXTURE_NONCE_PATTERN = /^[a-f0-9]{32}$/
const PACKAGE_SNAPSHOT_EXCLUDED_NAMES = new Set(['.git', 'node_modules'])

/**
 * Binds an approval to the exact manifest bytes and live validator options.
 *
 * @param {object} input approval inputs
 * @param {object} input.manifest loaded manifest
 * @param {string} input.out validation output directory
 * @param {string[]} [input.selectedFrameworkIds] selected framework ids
 * @param {string|null} [input.requestedScenario] selected scenario
 * @param {string} input.offlineFixtureNonce random fixture-root nonce shown in the execution plan
 * @param {boolean} [input.keepTempFiles] whether generated files are retained
 * @param {boolean} [input.verbose] whether command progress is printed
 * @returns {string} SHA-256 approval digest
 */
function getApprovalDigest ({
  manifest,
  out,
  selectedFrameworkIds = [],
  requestedScenario = null,
  offlineFixtureNonce,
  keepTempFiles = false,
  verbose = false,
}) {
  const approvalJson = serializeApprovalMaterial({
    manifest,
    out,
    selectedFrameworkIds,
    requestedScenario,
    offlineFixtureNonce,
    keepTempFiles,
    verbose,
  })
  return crypto.createHash('sha256').update(approvalJson).digest('hex')
}

/**
 * Builds the complete, inspectable material covered by one approval fingerprint.
 *
 * Secret-like values are redacted for the artifact while the raw manifest digest still binds their exact bytes.
 *
 * @param {object} input approval inputs
 * @param {object} input.manifest loaded validation manifest
 * @param {string} input.out validation output directory
 * @param {string[]} [input.selectedFrameworkIds] selected framework identifiers
 * @param {string|null} [input.requestedScenario] selected validation scenario
 * @param {string} input.offlineFixtureNonce private offline fixture nonce
 * @param {boolean} [input.keepTempFiles] whether generated files remain after validation
 * @param {boolean} [input.verbose] whether verbose validation output is enabled
 * @returns {object} deterministic approval material
 */
function getApprovalMaterial ({
  manifest,
  out,
  selectedFrameworkIds = [],
  requestedScenario = null,
  offlineFixtureNonce,
  keepTempFiles = false,
  verbose = false,
}) {
  if (!OFFLINE_FIXTURE_NONCE_PATTERN.test(String(offlineFixtureNonce || ''))) {
    throw new Error('Invalid offline fixture nonce. Render a fresh plan with --print-plan.')
  }

  const validationDirectory = __dirname
  const packageRoot = path.resolve(validationDirectory, '..', '..')
  const packageJsonPath = path.join(packageRoot, 'package.json')
  const packageMetadata = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  const packageFiles = getPackageFiles(packageRoot, [manifest.__path, out])
  const executableIdentities = bindManifestExecutables(manifest)

  return {
    schemaVersion: 1,
    sharingWarning: 'Internal diagnostic material. Review repository paths, commands, and CI metadata before sharing.',
    validator: {
      package: packageMetadata.name,
      version: packageMetadata.version,
      packageRoot,
      coveredFiles: packageFiles.map(filename => ({
        path: path.relative(packageRoot, filename).split(path.sep).join('/'),
        sha256: getFileDigest(filename),
      })),
    },
    manifest: {
      path: path.resolve(manifest.__path),
      sha256: getManifestDigest(manifest),
    },
    selection: {
      frameworks: [...selectedFrameworkIds],
      scenario: requestedScenario,
    },
    validation: {
      outputDirectory: path.resolve(out),
      offlineFixtureNonce,
      keepTemporaryFiles: keepTempFiles,
      verbose,
    },
    fixtureRecipeDigests: getFixtureRecipeDigests({
      frameworks: manifest.frameworks || [],
      selectedFrameworkIds,
      requestedScenario,
    }),
    commands: getManifestCommands(manifest).map(([id, command]) => getApprovalCommand(id, command)),
    generatedFiles: getGeneratedFileMaterial(manifest),
    executables: executableIdentities,
  }
}

/**
 * Serializes approval material using stable formatting suitable for independent SHA-256 tools.
 *
 * @param {object} input approval inputs
 * @returns {string} UTF-8 JSON text ending in one newline
 */
function serializeApprovalMaterial (input) {
  return `${JSON.stringify(getApprovalMaterial(input), null, 2)}\n`
}

/**
 * Returns every regular file owned by the installed dd-trace package.
 *
 * @param {string} packageRoot installed dd-trace package root
 * @param {string[]} excludedPaths generated files or directories outside the package snapshot
 * @returns {string[]} sorted absolute file paths
 */
function getPackageFiles (packageRoot, excludedPaths) {
  const files = []
  collectPackageFiles(
    fs.realpathSync(packageRoot),
    excludedPaths.map(resolvePhysicalPath),
    files
  )
  return files.sort()
}

/**
 * Converts one manifest command into its sanitized, execution-relevant approval shape.
 *
 * @param {string} id stable command identifier
 * @param {object} command structured command
 * @returns {object} command approval material
 */
function getApprovalCommand (id, command) {
  const shape = {
    id,
    required: command.required !== false,
    usesShell: command.usesShell === true,
    cwd: path.resolve(command.cwd),
    environmentMode: 'clean',
    environment: command.env || {},
    ...getCommandExecutionSettings(command),
    outputPaths: getCommandOutputPaths(command),
  }
  if (command.usesShell) {
    shape.shell = command.shell || null
    shape.shellCommand = command.shellCommand
  } else {
    shape.argv = command.argv
  }
  return sanitizeForReport(shape)
}

/**
 * Returns exact generated test source and cleanup policy covered by the manifest digest.
 *
 * @param {object} manifest loaded manifest
 * @returns {object[]} generated file approval material
 */
function getGeneratedFileMaterial (manifest) {
  const files = []
  for (const framework of manifest.frameworks || []) {
    const strategy = framework.generatedTestStrategy
    for (const file of strategy?.files || []) {
      const content = `${file.contentLines.join('\n')}\n`
      files.push(sanitizeForReport({
        frameworkId: framework.id,
        path: path.resolve(file.path),
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        content,
        removeAfterValidation: (strategy.cleanupPaths || []).some(cleanupPath => {
          return path.resolve(cleanupPath) === path.resolve(file.path)
        }),
      }))
    }
  }
  return files
}

/**
 * Hashes one covered regular file.
 *
 * @param {string} filename absolute filename
 * @returns {string} lowercase SHA-256 digest
 */
function getFileDigest (filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
}

/**
 * Collects regular package files without following package-internal symbolic links.
 *
 * @param {string} directory current package directory
 * @param {string[]} excludedPaths generated paths omitted from the package snapshot
 * @param {string[]} files collected files
 */
function collectPackageFiles (directory, excludedPaths, files) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (PACKAGE_SNAPSHOT_EXCLUDED_NAMES.has(entry.name) || isExcludedPackagePath(filename, excludedPaths)) continue
    if (entry.isDirectory()) {
      collectPackageFiles(filename, excludedPaths, files)
    } else if (entry.isFile()) {
      files.push(filename)
    }
  }
}

/**
 * Checks whether a package path belongs to a generated approval input or output.
 *
 * @param {string} filename package path
 * @param {string[]} excludedPaths generated paths omitted from the package snapshot
 * @returns {boolean} whether the path is excluded
 */
function isExcludedPackagePath (filename, excludedPaths) {
  return excludedPaths.some(excluded => filename === excluded || filename.startsWith(`${excluded}${path.sep}`))
}

/**
 * Resolves an existing path or its nearest existing ancestor through filesystem aliases.
 *
 * @param {string} filename path that may not exist yet
 * @returns {string} physical path
 */
function resolvePhysicalPath (filename) {
  const missingSegments = []
  let existingPath = path.resolve(filename)
  while (!fs.existsSync(existingPath)) {
    missingSegments.unshift(path.basename(existingPath))
    const parent = path.dirname(existingPath)
    if (parent === existingPath) return path.resolve(filename)
    existingPath = parent
  }
  return path.join(fs.realpathSync(existingPath), ...missingSegments)
}

/**
 * Validates an approval digest before live validation executes project code.
 *
 * @param {string} digest supplied approval digest
 * @param {object} input approval inputs
 * @returns {void}
 */
function assertApprovalDigest (digest, input) {
  if (!APPROVAL_DIGEST_PATTERN.test(String(digest || ''))) {
    throw new Error('Invalid --approved-plan-sha256 value. Render a fresh plan with --print-plan.')
  }

  const expected = getApprovalDigest(input)
  if (digest !== expected) {
    throw new Error(
      'The validation manifest or execution options changed after approval. ' +
      'Render a fresh plan with --print-plan and approve that exact plan before live validation.'
    )
  }
}

function getManifestDigest (manifest) {
  if (manifest.__sourceSha256) return manifest.__sourceSha256

  const serializable = { ...manifest }
  delete serializable.__path
  return crypto.createHash('sha256').update(JSON.stringify(serializable)).digest('hex')
}

module.exports = {
  assertApprovalDigest,
  getApprovalDigest,
  getApprovalMaterial,
  serializeApprovalMaterial,
}
