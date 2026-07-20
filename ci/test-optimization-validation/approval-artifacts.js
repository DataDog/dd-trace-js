'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { getApprovalMaterial } = require('./approval')
const { parseBoundedJson } = require('./bounded-json')
const { ensureSafeDirectory, writeFileSafely } = require('./safe-files')

const APPROVAL_FILENAME = 'approval.json'
const APPROVAL_FILES_FILENAME = 'approval-files.sha256'
const APPROVAL_DIGEST_PATTERN = /^[a-f0-9]{64}$/
const MAX_APPROVAL_BYTES = 5 * 1024 * 1024
const MAX_APPROVAL_COLLECTION_ENTRIES = 100_000
const MAX_APPROVAL_NESTING_DEPTH = 64
const MAX_APPROVAL_STRING_BYTES = 256 * 1024

/**
 * Writes inspectable approval material without running project code.
 *
 * The live validator verifies the exact approval JSON bytes first, reads only the bounded execution selection,
 * then reconstructs the full material from current inputs before running project code.
 *
 * @param {object} input approval inputs
 * @param {object} input.manifest loaded manifest
 * @param {string} input.out validation output directory
 * @returns {{approvalJsonPath: string, coveredFilesPath: string, digest: string}} written artifact details
 */
function writeApprovalArtifacts (input) {
  const material = getApprovalMaterial(input)
  const approvalJson = `${JSON.stringify(material, null, 2)}\n`
  const digest = crypto.createHash('sha256').update(approvalJson).digest('hex')
  const approvalJsonPath = path.join(input.out, APPROVAL_FILENAME)
  const coveredFilesPath = path.join(input.out, APPROVAL_FILES_FILENAME)

  ensureSafeDirectory(input.manifest.repository.root, input.out, 'validation approval artifact directory', {
    allowRootSymlink: true,
  })
  writeFileSafely(input.out, approvalJsonPath, approvalJson, 'validation approval JSON')
  writeFileSafely(
    input.out,
    coveredFilesPath,
    getCoveredFilesManifest(material),
    'validation approval file checksums'
  )

  return { approvalJsonPath, coveredFilesPath, digest }
}

/**
 * Loads the reviewed approval file only after its exact bytes match the user-approved SHA-256.
 *
 * @param {string} approvalPath approval JSON path
 * @param {string} expectedDigest user-approved SHA-256
 * @returns {{material: object, path: string}} verified approval material
 */
function loadApprovedPlan (approvalPath, expectedDigest) {
  if (!APPROVAL_DIGEST_PATTERN.test(String(expectedDigest || ''))) {
    throw new Error('Invalid --sha256 value. Render a fresh plan with --print-plan.')
  }

  const resolvedPath = path.resolve(approvalPath)
  const stat = fs.lstatSync(resolvedPath)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Approved plan must be a regular file, not a symbolic link: ${resolvedPath}`)
  }
  if (stat.size > MAX_APPROVAL_BYTES) {
    throw new Error(`Approved plan exceeds the ${MAX_APPROVAL_BYTES}-byte size limit: ${resolvedPath}`)
  }

  const raw = fs.readFileSync(resolvedPath)
  const digest = crypto.createHash('sha256').update(raw).digest('hex')
  if (digest !== expectedDigest) {
    throw new Error('The approved plan file changed after approval. Render and approve a fresh execution plan.')
  }

  const material = parseBoundedJson(raw, {
    label: 'Approved validation plan JSON',
    maxCollectionEntries: MAX_APPROVAL_COLLECTION_ENTRIES,
    maxNestingDepth: MAX_APPROVAL_NESTING_DEPTH,
    maxStringBytes: MAX_APPROVAL_STRING_BYTES,
  }).value
  validateApprovedPlanShape(material, resolvedPath)
  return { material, path: resolvedPath }
}

/**
 * Validates the small set of approval fields used to reconstruct live CLI options.
 *
 * @param {object} material parsed approval material
 * @param {string} approvalPath approved JSON path
 * @returns {void}
 */
function validateApprovedPlanShape (material, approvalPath) {
  const manifestPath = material?.manifest?.path
  const outputDirectory = material?.validation?.outputDirectory
  const frameworks = material?.selection?.frameworks
  const scenario = material?.selection?.scenario
  if (typeof manifestPath !== 'string' || !path.isAbsolute(manifestPath)) {
    throw new Error('Approved plan manifest.path must be an absolute path.')
  }
  if (typeof outputDirectory !== 'string' || !path.isAbsolute(outputDirectory)) {
    throw new Error('Approved plan validation.outputDirectory must be an absolute path.')
  }
  if (!Array.isArray(frameworks) || frameworks.some(framework => typeof framework !== 'string')) {
    throw new Error('Approved plan selection.frameworks must be an array of framework identifiers.')
  }
  if (scenario !== null && typeof scenario !== 'string') {
    throw new Error('Approved plan selection.scenario must be a string or null.')
  }
  if (path.resolve(approvalPath) !== path.join(path.resolve(outputDirectory), APPROVAL_FILENAME)) {
    throw new Error(`Approved plan must be ${APPROVAL_FILENAME} inside validation.outputDirectory.`)
  }
}

/**
 * Creates a standard SHA-256 checksum list for independently checking covered files.
 *
 * @param {object} material approval material
 * @returns {string} checksum manifest
 */
function getCoveredFilesManifest (material) {
  const files = new Map([[material.manifest.path, material.manifest.sha256]])
  for (const file of material.validator.coveredFiles) {
    files.set(path.join(material.validator.packageRoot, ...file.path.split('/')), file.sha256)
  }
  for (const executable of material.executables) {
    files.set(executable.path, executable.sha256)
    for (const delegated of executable.delegated || []) files.set(delegated.path, delegated.sha256)
  }

  return [...files]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filename, sha256]) => `${sha256}  ${filename}`)
    .join('\n') + '\n'
}

module.exports = {
  getCoveredFilesManifest,
  loadApprovedPlan,
  writeApprovalArtifacts,
}
