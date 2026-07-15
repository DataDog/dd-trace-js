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
  const validatorFiles = getValidatorFiles(packageRoot, validationDirectory)
  const executableIdentities = bindManifestExecutables(manifest)

  return {
    schemaVersion: 1,
    sharingWarning: 'Internal diagnostic material. Review repository paths, commands, and CI metadata before sharing.',
    validator: {
      package: packageMetadata.name,
      version: packageMetadata.version,
      packageRoot,
      coveredFiles: validatorFiles.map(filename => ({
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
 * Returns every installed validator/runtime file included in the approval fingerprint.
 *
 * @param {string} packageRoot installed dd-trace package root
 * @param {string} validationDirectory validator source directory
 * @returns {string[]} sorted absolute file paths
 */
function getValidatorFiles (packageRoot, validationDirectory) {
  return [
    path.resolve(packageRoot, 'package.json'),
    path.resolve(validationDirectory, '..', 'diagnose.js'),
    path.resolve(validationDirectory, '..', 'init.js'),
    path.resolve(validationDirectory, '..', 'validate-test-optimization.js'),
    path.resolve(packageRoot, 'loader-hook.mjs'),
    path.resolve(packageRoot, 'register.js'),
    path.resolve(packageRoot, 'version.js'),
    path.resolve(packageRoot, 'ext', 'exporters.js'),
    path.resolve(packageRoot, 'packages', 'dd-trace', 'src', 'exporter.js'),
    path.resolve(packageRoot, 'packages', 'dd-trace', 'src', 'proxy.js'),
    path.resolve(
      packageRoot,
      'packages',
      'dd-trace',
      'src',
      'ci-visibility',
      'exporters',
      'ci-visibility-exporter.js'
    ),
    path.resolve(packageRoot, 'packages', 'dd-trace', 'src', 'ci-visibility', 'test-optimization-http-cache.js'),
    path.resolve(
      packageRoot,
      'packages',
      'dd-trace',
      'src',
      'ci-visibility',
      'test-optimization-http-cache-schema.js'
    ),
    path.resolve(
      packageRoot,
      'packages',
      'dd-trace',
      'src',
      'ci-visibility',
      'requests',
      'get-library-configuration.js'
    ),
    path.resolve(
      packageRoot,
      'packages',
      'dd-trace',
      'src',
      'ci-visibility',
      'early-flake-detection',
      'get-known-tests.js'
    ),
    path.resolve(
      packageRoot,
      'packages',
      'dd-trace',
      'src',
      'ci-visibility',
      'intelligent-test-runner',
      'get-skippable-suites.js'
    ),
    path.resolve(
      packageRoot,
      'packages',
      'dd-trace',
      'src',
      'ci-visibility',
      'test-management',
      'get-test-management-tests.js'
    ),
    ...collectJavaScriptFiles(path.resolve(
      packageRoot,
      'packages',
      'dd-trace',
      'src',
      'ci-visibility',
      'exporters',
      'ci-validation'
    )),
    ...collectJavaScriptFiles(validationDirectory),
  ].sort()
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

function collectJavaScriptFiles (directory) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectJavaScriptFiles(filename))
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(filename)
    }
  }
  return files
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
