'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  assertApprovalDigest,
  getApprovalDigest,
  getApprovalMaterial,
  serializeApprovalMaterial,
} = require('../../../../ci/test-optimization-validation/approval')
const { loadManifest } = require('../../../../ci/test-optimization-validation/manifest-loader')

describe('test optimization validation approval', () => {
  it('binds approval to every regular installed package file', () => {
    const packageRoot = path.resolve(__dirname, '../../../..')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-approval-preloads-'))
    const copiedPackageRoot = path.join(root, 'dd-trace')
    const copiedValidationDirectory = path.join(copiedPackageRoot, 'ci', 'test-optimization-validation')
    const copiedFiles = [
      'package.json',
      'ci/diagnose.js',
      'ci/init.js',
      'ci/validate-test-optimization.js',
      'loader-hook.mjs',
      'register.js',
      'version.js',
      'ext/exporters.js',
      'packages/dd-trace/src/exporter.js',
      'packages/dd-trace/src/proxy.js',
      'packages/dd-trace/src/encode/agentless-ci-visibility.js',
    ]

    fs.cpSync(path.join(packageRoot, 'ci', 'test-optimization-validation'), copiedValidationDirectory, {
      recursive: true,
    })
    fs.cpSync(
      path.join(packageRoot, 'packages', 'dd-trace', 'src', 'ci-visibility'),
      path.join(copiedPackageRoot, 'packages', 'dd-trace', 'src', 'ci-visibility'),
      { recursive: true }
    )
    for (const relativePath of copiedFiles) {
      const destination = path.join(copiedPackageRoot, relativePath)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.copyFileSync(path.join(packageRoot, relativePath), destination)
    }

    const copiedApproval = require(path.join(copiedValidationDirectory, 'approval'))
    const input = {
      manifest: { __path: path.join(root, 'manifest.json'), repository: { root } },
      offlineFixtureNonce: '0'.repeat(32),
      out: path.join(copiedPackageRoot, 'results'),
    }

    try {
      let digest = copiedApproval.getApprovalDigest(input)
      for (const relativePath of [
        'ci/init.js',
        'register.js',
        'loader-hook.mjs',
        'version.js',
        'packages/dd-trace/src/proxy.js',
        'packages/dd-trace/src/encode/agentless-ci-visibility.js',
        'packages/dd-trace/src/ci-visibility/exporters/ci-validation/index.js',
      ]) {
        fs.appendFileSync(path.join(copiedPackageRoot, relativePath), '\n// changed after approval\n')
        const changedDigest = copiedApproval.getApprovalDigest(input)
        assert.notStrictEqual(changedDigest, digest, `${relativePath} must affect the approval digest`)
        digest = changedDigest
      }

      const addedRuntimeFile = path.join(copiedPackageRoot, 'packages', 'dd-trace', 'src', 'future-runtime.bin')
      fs.writeFileSync(addedRuntimeFile, 'new package file')
      const addedFileDigest = copiedApproval.getApprovalDigest(input)
      assert.notStrictEqual(addedFileDigest, digest, 'new package files must affect the approval digest')
      digest = addedFileDigest

      const dependencyFile = path.join(copiedPackageRoot, 'node_modules', 'dependency', 'index.js')
      fs.mkdirSync(path.dirname(dependencyFile), { recursive: true })
      fs.writeFileSync(dependencyFile, 'dependency version one')
      assert.strictEqual(copiedApproval.getApprovalDigest(input), digest)
      fs.writeFileSync(dependencyFile, 'dependency version two')
      assert.strictEqual(copiedApproval.getApprovalDigest(input), digest)

      const coverageProfile = path.join(copiedPackageRoot, '.nyc_output', 'coverage.json')
      fs.mkdirSync(path.dirname(coverageProfile), { recursive: true })
      fs.writeFileSync(coverageProfile, 'coverage version one')
      assert.strictEqual(copiedApproval.getApprovalDigest(input), digest)
      fs.writeFileSync(coverageProfile, 'coverage version two')
      assert.strictEqual(copiedApproval.getApprovalDigest(input), digest)

      const gitMetadataFile = path.join(copiedPackageRoot, '.git')
      fs.writeFileSync(gitMetadataFile, 'gitdir: outside-the-package')
      assert.strictEqual(copiedApproval.getApprovalDigest(input), digest)

      fs.mkdirSync(input.out)
      fs.writeFileSync(path.join(input.out, 'approval.json'), 'generated approval output')
      assert.strictEqual(copiedApproval.getApprovalDigest(input), digest)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('serializes inspectable material whose bytes reproduce the approval digest', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-approval-material-'))
    const manifestPath = path.join(root, 'manifest.json')
    const manifestSource = getManifest(root, [process.execPath, '-e', 'console.log("API_KEY=secret")'])
    manifestSource.frameworks[0].existingTestCommand.env = { API_KEY: 'secret', SAFE_MODE: 'enabled' }
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifestSource)}\n`)
    const manifest = { ...manifestSource, __path: manifestPath }
    const input = {
      manifest,
      offlineFixtureNonce: '0'.repeat(32),
      out: path.join(root, 'results'),
    }

    try {
      const approvalJson = serializeApprovalMaterial(input)
      const material = getApprovalMaterial(input)
      const independentDigest = crypto.createHash('sha256').update(approvalJson).digest('hex')

      assert.strictEqual(independentDigest, getApprovalDigest(input))
      assert.strictEqual(`${JSON.stringify(material, null, 2)}\n`, approvalJson)
      assert.strictEqual(material.commands[0].environment.API_KEY, '<redacted>')
      assert.strictEqual(material.commands[0].environment.SAFE_MODE, 'enabled')
      assert.doesNotMatch(approvalJson, /API_KEY=secret/)
      assert.match(material.commands[0].argv[2], /API_KEY=<redacted>/)
      assert.ok(material.validator.coveredFiles.some(file => file.path === 'package.json'))
      assert.ok(material.validator.coveredFiles.some(file => {
        return file.path === 'packages/dd-trace/src/encode/agentless-ci-visibility.js'
      }))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects manifest or option changes made after the plan was rendered', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-approval-'))
    const manifestPath = path.join(root, 'manifest.json')
    const out = path.join(root, 'results')
    const input = {
      out,
      offlineFixtureNonce: '0'.repeat(32),
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
      assert.throws(() => assertApprovalDigest(digest, {
        manifest: approvedManifest,
        ...input,
        offlineFixtureNonce: '1'.repeat(32),
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

  it('refuses command output paths that escape through a repository symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-approval-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-approval-outside-'))
    const linkedDirectory = path.join(root, 'linked')
    const manifestPath = path.join(root, 'manifest.json')
    const manifest = getManifest(root, ['npm', 'test'])
    manifest.frameworks[0].existingTestCommand.outputPaths = [path.join(linkedDirectory, 'coverage')]

    try {
      fs.symlinkSync(outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`)
      assert.throws(() => loadManifest(manifestPath), /outputPaths\[0\] resolves outside repository\.root/)
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
