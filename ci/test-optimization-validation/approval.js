'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const APPROVAL_DIGEST_PATTERN = /^[a-f0-9]{64}$/

/**
 * Binds an approval to the exact manifest bytes and live validator options.
 *
 * @param {object} input approval inputs
 * @param {object} input.manifest loaded manifest
 * @param {string} input.out validation output directory
 * @param {string[]} [input.selectedFrameworkIds] selected framework ids
 * @param {string|null} [input.requestedScenario] selected scenario
 * @param {boolean} [input.keepTempFiles] whether generated files are retained
 * @param {boolean} [input.verbose] whether command progress is printed
 * @returns {string} SHA-256 approval digest
 */
function getApprovalDigest ({
  manifest,
  out,
  selectedFrameworkIds = [],
  requestedScenario = null,
  keepTempFiles = false,
  verbose = false,
}) {
  const scope = {
    manifestPath: path.resolve(manifest.__path),
    manifestSha256: getManifestDigest(manifest),
    out: path.resolve(out),
    selectedFrameworkIds: [...selectedFrameworkIds],
    requestedScenario,
    keepTempFiles,
    verbose,
    validatorSha256: getValidatorDigest(),
  }
  return crypto.createHash('sha256').update(JSON.stringify(scope)).digest('hex')
}

function getValidatorDigest () {
  const validationDirectory = __dirname
  const packageRoot = path.resolve(validationDirectory, '..', '..')
  const files = [
    path.resolve(validationDirectory, '..', 'diagnose.js'),
    path.resolve(validationDirectory, '..', 'init.js'),
    path.resolve(validationDirectory, '..', 'validate-test-optimization.js'),
    path.resolve(packageRoot, 'loader-hook.mjs'),
    path.resolve(packageRoot, 'register.js'),
    path.resolve(packageRoot, 'version.js'),
    ...collectJavaScriptFiles(validationDirectory),
  ].sort()
  const hash = crypto.createHash('sha256')
  for (const filename of files) {
    hash.update(path.relative(path.dirname(validationDirectory), filename))
    hash.update('\0')
    hash.update(fs.readFileSync(filename))
    hash.update('\0')
  }
  return hash.digest('hex')
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
}
