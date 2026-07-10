'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  assertApprovalDigest,
  getApprovalDigest,
} = require('../../../../ci/test-optimization-validation/approval')
const { loadManifest } = require('../../../../ci/test-optimization-validation/manifest-loader')

describe('test optimization validation approval', () => {
  it('rejects manifest or option changes made after the plan was rendered', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-approval-'))
    const manifestPath = path.join(root, 'manifest.json')
    const out = path.join(root, 'results')
    const input = {
      out,
      selectedFrameworkIds: [],
      requestedScenario: null,
      keepTempFiles: false,
      verbose: false,
    }

    try {
      fs.writeFileSync(manifestPath, `${JSON.stringify(getManifest(root, ['npm', 'test']))}\n`)
      const approvedManifest = loadManifest(manifestPath)
      const digest = getApprovalDigest({ manifest: approvedManifest, ...input })

      assertApprovalDigest(digest, { manifest: approvedManifest, ...input })
      assert.throws(() => assertApprovalDigest(digest, {
        manifest: approvedManifest,
        ...input,
        out: path.join(root, 'different-results'),
      }), /changed after approval/)

      fs.writeFileSync(manifestPath, `${JSON.stringify(getManifest(root, ['sh', '-c', 'echo changed']))}\n`)
      const changedManifest = loadManifest(manifestPath)
      assert.throws(() => assertApprovalDigest(digest, { manifest: changedManifest, ...input }), {
        message: /changed after approval/,
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses manifests outside the repository or reached through a symbolic link', function () {
    if (process.platform === 'win32') this.skip()

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-approval-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-approval-outside-'))
    const outsideManifest = path.join(outside, 'manifest.json')
    const linkedManifest = path.join(root, 'manifest.json')

    try {
      fs.writeFileSync(outsideManifest, `${JSON.stringify(getManifest(root, ['npm', 'test']))}\n`)
      assert.throws(() => loadManifest(outsideManifest), /stored directly in repository.root/)

      fs.symlinkSync(outsideManifest, linkedManifest)
      assert.throws(() => loadManifest(linkedManifest), /regular file, not a symbolic link/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses command working directories that escape through a repository symlink', function () {
    if (process.platform === 'win32') this.skip()

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-approval-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-approval-outside-'))
    const linkedDirectory = path.join(root, 'linked')
    const manifestPath = path.join(root, 'manifest.json')
    const manifest = getManifest(root, ['npm', 'test'])
    manifest.frameworks[0].existingTestCommand.cwd = linkedDirectory

    try {
      fs.symlinkSync(outside, linkedDirectory)
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`)
      assert.throws(() => loadManifest(manifestPath), /resolves outside repository.root/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

function getManifest (root, argv) {
  return {
    schemaVersion: '1.0',
    repository: { root },
    environment: { os: 'darwin' },
    frameworks: [{
      id: 'jest:root',
      framework: 'jest',
      status: 'runnable',
      project: { root },
      existingTestCommand: { cwd: root, argv },
      preflight: { ran: false },
      ciWiring: { status: 'skip', reason: 'No CI command selected.' },
    }],
  }
}
