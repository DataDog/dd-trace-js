'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const {
  assertApprovalDigest,
  getApprovalDigest,
  getApprovalMaterial,
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
    assert.doesNotMatch(json, /npm (?:run |test)|shellCommand|setupCommands/)
  })

  it('does not approve local execution for a CI-only audit', () => {
    const material = getApprovalMaterial({ ...input, requestedScenario: 'ci-wiring' })

    assert.deepStrictEqual(material.commands, [])
    assert.deepStrictEqual(material.executables, [])
    assert.deepStrictEqual(material.fixtureRecipeDigests, [])
    assert.deepStrictEqual(material.generatedFiles, [])
    assert.deepStrictEqual(material.projectFiles, [])
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

    assert.deepStrictEqual(material.projectFiles.map(file => file.path), [workflow])
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
