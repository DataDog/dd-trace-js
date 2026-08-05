'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const {
  assertApprovalDigest,
  getApprovalDigest,
  getApprovalMaterial,
  getApprovalProjectSnapshot,
  serializeApprovalMaterial,
} = require('../../../../ci/test-optimization-validation/approval')
const {
  loadApprovedPlan,
  writeApprovalArtifacts,
} = require('../../../../ci/test-optimization-validation/approval-artifacts')
const { getExecutableForSpawn } = require('../../../../ci/test-optimization-validation/executable')
const { getBasicCommand } = require('../../../../ci/test-optimization-validation/runner-command')
const {
  createLoadedManifest,
  createRepositoryFixture,
  removeFixture,
} = require('./validation-test-helpers')

describe('test optimization validation approval', () => {
  let fixture
  let input

  beforeEach(() => {
    fixture = createRepositoryFixture({ framework: 'mocha' })
    input = {
      manifest: createLoadedManifest(fixture.root, 'mocha'),
      offlineFixtureNonce: '0'.repeat(32),
      out: path.join(fixture.root, 'dd-test-optimization-validation-results'),
    }
  })

  afterEach(() => removeFixture(fixture.root))

  it('binds only direct commands and every project-controlled input', () => {
    const json = serializeApprovalMaterial(input)
    const material = getApprovalMaterial(input)

    assert.strictEqual(
      crypto.createHash('sha256').update(json).digest('hex'),
      getApprovalDigest(input)
    )
    assert.ok(material.commands.length >= 4)
    assert.ok(material.commands.every(command => {
      return command.usesShell === false &&
        command.argv[0] === process.execPath &&
        command.argv[1] === fs.realpathSync(fixture.runner)
    }))
    assert.deepStrictEqual(material.projectFiles.map(file => file.path).sort(), [
      path.join(fixture.root, 'package.json'),
      fs.realpathSync(fixture.runner),
      fixture.testFile,
    ].sort())
    assert.deepStrictEqual(material.validation.requiredCapabilities, [])
    assert.doesNotMatch(json, /npm (?:run |test)|shellCommand|setupCommands/)
  })

  it('binds static package input without approving local execution for a CI-only audit', () => {
    const approvalInput = { ...input, requestedScenario: 'ci-wiring' }
    const material = getApprovalMaterial(approvalInput)
    const digest = getApprovalDigest(approvalInput)

    assert.deepStrictEqual(material.commands, [])
    assert.deepStrictEqual(material.executables, [])
    assert.deepStrictEqual(material.fixtureRecipeDigests, [])
    assert.deepStrictEqual(material.generatedFiles, [])
    assert.deepStrictEqual(material.validation.requiredCapabilities, [])
    assert.deepStrictEqual(material.projectFiles.map(file => file.path), [
      path.join(fixture.root, 'package.json'),
    ])
    fs.appendFileSync(path.join(fixture.root, 'package.json'), ' ')
    assert.notStrictEqual(getApprovalDigest(approvalInput), digest)
  })

  it('snapshots package scripts for a non-runnable framework in a mixed plan', () => {
    input.manifest.frameworks[0].status = 'requires_manual_setup'
    const snapshot = getApprovalProjectSnapshot(input.manifest)
    const packageJson = path.join(fixture.root, 'package.json')

    assert.ok(snapshot.sources.has(packageJson))
    assert.ok(snapshot.projectFiles.some(file => file.path === packageJson))
    assert.strictEqual(snapshot.sources.has(fs.realpathSync(fixture.runner)), false)
  })

  it('binds required browser and localhost capabilities without managing permissions', () => {
    const framework = input.manifest.frameworks[0]
    framework.browserRequired = true
    framework.localSocketRequired = true

    const material = getApprovalMaterial(input)

    assert.deepStrictEqual(material.validation.requiredCapabilities, [
      'browser_process',
      'localhost_socket',
    ])
  })

  it('derives mandatory browser capability from an inherently browser-backed framework', () => {
    const framework = input.manifest.frameworks[0]
    framework.framework = 'cypress'
    delete framework.browserRequired
    assert.deepStrictEqual(getApprovalMaterial(input).validation.requiredCapabilities, ['browser_process'])

    framework.browserRequired = false
    assert.deepStrictEqual(getApprovalMaterial(input).validation.requiredCapabilities, ['browser_process'])
  })

  it('derives browser capability from retained Vitest browser arguments', () => {
    const framework = input.manifest.frameworks[0]
    framework.framework = 'vitest'
    framework.validation.runnerArgs = ['--browser']
    framework.browserRequired = false

    assert.deepStrictEqual(getApprovalMaterial(input).validation.requiredCapabilities, ['browser_process'])
  })

  it('refuses to publish approval artifacts when project inputs changed during preflight', () => {
    const snapshot = getApprovalProjectSnapshot(input.manifest)
    const capturedTestSource = snapshot.sources.get(fixture.testFile).toString('utf8')
    fs.appendFileSync(fixture.testFile, '\n// changed during preflight\n')

    assert.throws(
      () => writeApprovalArtifacts({ ...input, expectedProjectFiles: snapshot.projectFiles }),
      /project inputs changed during plan preflight/
    )
    assert.doesNotMatch(capturedTestSource, /changed during preflight/)
    assert.strictEqual(fs.existsSync(path.join(input.out, 'approval.json')), false)
    assert.strictEqual(fs.existsSync(path.join(input.out, 'approval-files.sha256')), false)
  })

  it('binds a CI file when local framework validation is unavailable', () => {
    const workflow = path.join(fixture.root, '.github', 'workflows', 'test.yml')
    fs.mkdirSync(path.dirname(workflow), { recursive: true })
    fs.writeFileSync(workflow, 'jobs:\n  test:\n    steps: []\n')
    input.manifest.frameworks[0].status = 'requires_manual_setup'
    input.manifest.frameworks[0].ciWiring.configFile = workflow
    const approvalInput = { ...input, requestedScenario: 'ci-wiring' }
    const material = getApprovalMaterial(approvalInput)
    const digest = getApprovalDigest(approvalInput)

    assert.deepStrictEqual(material.projectFiles.map(file => file.path), [
      workflow,
      path.join(fixture.root, 'package.json'),
    ].sort())
    fs.appendFileSync(workflow, '# changed after approval\n')
    assert.notStrictEqual(getApprovalDigest(approvalInput), digest)
  })

  it('changes the approval digest when the selected test or runner changes', () => {
    const digest = getApprovalDigest(input)

    fs.appendFileSync(fixture.testFile, '\n// changed after review\n')
    assert.notStrictEqual(getApprovalDigest(input), digest)
    fs.appendFileSync(fixture.runner, '\n// changed after review\n')
    assert.notStrictEqual(getApprovalDigest(input), digest)
    assert.throws(() => assertApprovalDigest(digest, input), /changed after approval/)
  })

  it('revalidates the approved runner immediately before spawn', () => {
    getApprovalMaterial(input)
    const command = getBasicCommand(input.manifest.frameworks[0])

    assert.strictEqual(
      getExecutableForSpawn(command, { requireApproval: true }).path,
      fs.realpathSync(process.execPath)
    )
    fs.appendFileSync(fixture.runner, '\n// executable mutation\n')
    assert.throws(
      () => getExecutableForSpawn(command, { requireApproval: true }),
      /executable changed after approval/
    )
  })

  it('loads only the exact regular approval artifact', () => {
    const written = writeApprovalArtifacts(input)
    const loaded = loadApprovedPlan(written.approvalJsonPath, written.digest)

    assert.strictEqual(loaded.path, written.approvalJsonPath)
    const originalApproval = fs.readFileSync(written.approvalJsonPath)
    const invalidApproval = JSON.parse(originalApproval)
    invalidApproval.validation.requiredCapabilities = ['network_access']
    fs.writeFileSync(written.approvalJsonPath, `${JSON.stringify(invalidApproval)}\n`)
    const invalidDigest = crypto.createHash('sha256').update(fs.readFileSync(written.approvalJsonPath)).digest('hex')
    assert.throws(
      () => loadApprovedPlan(written.approvalJsonPath, invalidDigest),
      /validation.requiredCapabilities/
    )
    fs.writeFileSync(written.approvalJsonPath, originalApproval)
    fs.appendFileSync(written.approvalJsonPath, ' ')
    assert.throws(
      () => loadApprovedPlan(written.approvalJsonPath, written.digest),
      /changed after approval/
    )

    const stored = path.join(input.out, 'stored-approval.json')
    fs.renameSync(written.approvalJsonPath, stored)
    fs.symlinkSync(stored, written.approvalJsonPath)
    assert.throws(
      () => loadApprovedPlan(written.approvalJsonPath, written.digest),
      /regular file, not a symbolic link/
    )
  })
})
