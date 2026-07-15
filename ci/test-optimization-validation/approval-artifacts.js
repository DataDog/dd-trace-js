'use strict'

const crypto = require('node:crypto')
const path = require('node:path')

const { getApprovalMaterial } = require('./approval')
const { ensureSafeDirectory, writeFileSafely } = require('./safe-files')

const APPROVAL_FILENAME = 'approval.json'
const APPROVAL_FILES_FILENAME = 'approval-files.sha256'

/**
 * Writes inspectable approval material without running project code.
 *
 * The live validator reconstructs this material from current inputs; these files are for independent review and
 * are never trusted as execution authority.
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
  for (const executable of material.executables) files.set(executable.path, executable.sha256)

  return [...files]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filename, sha256]) => `${sha256}  ${filename}`)
    .join('\n') + '\n'
}

module.exports = {
  getCoveredFilesManifest,
  writeApprovalArtifacts,
}
