'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { runCiWiring } = require('../../../../ci/test-optimization-validation/scenarios/ci-wiring')
const {
  createLoadedManifest,
  createRepositoryFixture,
  removeFixture,
} = require('./validation-test-helpers')

describe('test optimization validation CI audit', () => {
  let fixture
  let manifest
  let framework
  let workflow
  const command = 'node ./node_modules/mocha/bin/mocha.js --reporter spec test/example.spec.js'

  beforeEach(() => {
    fixture = createRepositoryFixture({
      framework: 'mocha',
      ciSource: workflowSource({ command }),
    })
    manifest = createLoadedManifest(fixture.root, 'mocha')
    framework = manifest.frameworks[0]
    workflow = path.join(fixture.root, '.github', 'workflows', 'test.yml')
  })

  afterEach(() => removeFixture(fixture.root))

  it('stays incomplete until one exact CI path is fully reviewed', () => {
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.manifestIncomplete, true)
    assert.match(result.diagnosis, /review is not marked complete/)
  })

  it('confirms missing initialization only for a literal direct-runner job', () => {
    completeReview({ initialization: 'not_configured', transport: 'none' })
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'fail')
    assert.strictEqual(result.evidence.conclusion, 'confirmed_misconfigured')
    assert.strictEqual(result.evidence.evidenceStrength, 'confirmed_static')
    assert.match(result.diagnosis, /Test Optimization is not initialized/)
  })

  for (const wrapped of [
    'npm test',
    'npx mocha test/example.spec.js',
    'npx --no-install mocha test/example.spec.js',
    'pnpm run test:unit',
    'yarn test',
    'nx test project',
    'node ./scripts/test.js && echo done',
    `echo ${command}`,
    `${command} & wait`,
    `NODE_OPTIONS=$NODE_OPTIONS ${command}`,
  ]) {
    it(`fails closed for wrapper or dynamic command: ${wrapped}`, () => {
      fs.writeFileSync(workflow, workflowSource({ command: wrapped }))
      completeReview({ command: wrapped, initialization: 'not_configured', transport: 'none' })
      const result = runCiWiring({ framework, manifest })

      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.manifestIncomplete, true)
      assert.match(result.diagnosis, /dynamic or reaches the test runner through a wrapper/)
    })
  }

  it('does not treat a NODE_OPTIONS reset in another job as a confirmed finding', () => {
    fs.writeFileSync(workflow, [
      workflowSource({ command }),
      '  unrelated:',
      '    steps:',
      '      - run: NODE_OPTIONS="" node other.js',
    ].join('\n'))
    completeReview({ initialization: 'configured', transport: 'agent' })
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'incomplete')
    assert.notStrictEqual(result.evidence.conclusion, 'confirmed_misconfigured')
  })

  it('confirms the selected reviewed job is unconfigured when another job initializes dd-trace', () => {
    fs.writeFileSync(workflow, [
      workflowSource({ command }),
      '  unrelated:',
      '    env:',
      '      NODE_OPTIONS: -r dd-trace/ci/init',
      '    steps:',
      '      - run: node other.js',
    ].join('\n'))
    completeReview({ initialization: 'not_configured', transport: 'none' })
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'fail')
    assert.strictEqual(result.evidence.conclusion, 'confirmed_misconfigured')
    assert.match(result.diagnosis, /not initialized/)
  })

  it('does not bind a selected job to a command found only in another job', () => {
    fs.writeFileSync(workflow, [
      'jobs:',
      '  test:',
      '    steps:',
      '      - run: node ./scripts/other.js',
      '  unrelated:',
      '    steps:',
      `      - run: ${command}`,
      '',
    ].join('\n'))
    completeReview({ initialization: 'not_configured', transport: 'none' })
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'incomplete')
    assert.match(result.diagnosis, /could not be bound structurally to the selected job/)
  })

  it('confirms a reset in the selected direct command', () => {
    const resetCommand = `NODE_OPTIONS="" ${command}`
    fs.writeFileSync(workflow, workflowSource({ command: resetCommand }))
    completeReview({ command: resetCommand, initialization: 'configured', transport: 'agent' })
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'fail')
    assert.match(result.diagnosis, /explicitly clears NODE_OPTIONS/)
  })

  it('does not treat text in the selected step label as an effective reset', () => {
    const step = 'NODE_OPTIONS="" diagnostic'
    fs.writeFileSync(workflow, [
      'jobs:',
      '  test:',
      '    env:',
      '      NODE_OPTIONS: -r dd-trace/ci/init',
      '    steps:',
      `      - name: ${step}`,
      `        run: ${command}`,
      '',
    ].join('\n'))
    completeReview({ initialization: 'configured', transport: 'agent' })
    framework.ciWiring.step = step
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'configured_propagation_unverified')
    assert.doesNotMatch(result.diagnosis, /explicitly clears NODE_OPTIONS/)
  })

  it('uses the final inline NODE_OPTIONS assignment before the selected runner', () => {
    const restoredCommand = `NODE_OPTIONS="" NODE_OPTIONS="-r dd-trace/ci/init" ${command}`
    fs.writeFileSync(workflow, workflowSource({ command: restoredCommand }))
    completeReview({ command: restoredCommand, initialization: 'configured', transport: 'agent' })
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'configured_propagation_unverified')
    assert.doesNotMatch(result.diagnosis, /explicitly clears NODE_OPTIONS/)
  })

  it('does not treat NODE_OPTIONS text inside another assignment as a reset', () => {
    const textCommand = `NOTE=NODE_OPTIONS="" ${command}`
    fs.writeFileSync(workflow, workflowSource({
      command: textCommand,
      env: ['      NODE_OPTIONS: -r dd-trace/ci/init'],
    }))
    completeReview({ command: textCommand, initialization: 'configured', transport: 'agent' })
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'configured_propagation_unverified')
    assert.doesNotMatch(result.diagnosis, /explicitly clears NODE_OPTIONS/)
  })

  it('does not treat NODE_OPTIONS text inside another quoted assignment as a reset', () => {
    const textCommand = `NOTE="text NODE_OPTIONS=''" ${command}`
    fs.writeFileSync(workflow, workflowSource({
      command: textCommand,
      env: ['      NODE_OPTIONS: -r dd-trace/ci/init'],
    }))
    completeReview({ command: textCommand, initialization: 'configured', transport: 'agent' })
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'configured_propagation_unverified')
    assert.doesNotMatch(result.diagnosis, /explicitly clears NODE_OPTIONS/)
  })

  it('fails closed when NODE_OPTIONS changes through multiline shell flow', () => {
    const multilineCommand = `NODE_OPTIONS=""\nNODE_OPTIONS="-r dd-trace/ci/init" ${command}`
    fs.writeFileSync(workflow, workflowSource({ command: multilineCommand }))
    completeReview({ command: multilineCommand, initialization: 'configured', transport: 'agent' })
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'incomplete')
    assert.match(result.diagnosis, /could not be bound structurally|dynamic/)
  })

  it('does not trust a fabricated selected step', () => {
    completeReview({ initialization: 'configured', transport: 'agent' })
    framework.ciWiring.step = `run: NODE_OPTIONS="" ${command}`
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'incomplete')
    assert.match(result.diagnosis, /could not be bound structurally to the selected job/)
  })

  it('keeps a missing agentless API key reference incomplete', () => {
    fs.writeFileSync(workflow, workflowSource({
      command,
      env: [
        '      NODE_OPTIONS: -r dd-trace/ci/init',
        '      DD_CIVISIBILITY_AGENTLESS_ENABLED: "1"',
      ],
    }))
    completeReview({ initialization: 'configured', transport: 'agentless' })
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'incomplete')
    assert.match(result.diagnosis, /may still be injected outside this file/)
  })

  it('reports configured static wiring as propagation-unverified', () => {
    fs.writeFileSync(workflow, workflowSource({
      command,
      env: ['      NODE_OPTIONS: -r dd-trace/ci/init'],
    }))
    completeReview({ initialization: 'configured', transport: 'agent' })
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'configured_propagation_unverified')
    assert.match(result.diagnosis, /cannot prove.*final process/)
  })

  it('rejects stale job or command evidence', () => {
    completeReview({ command: `${command} --changed`, initialization: 'not_configured', transport: 'none' })
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'error')
    assert.match(result.diagnosis, /could not be bound structurally to the selected job/)
  })

  /**
   * Populates review-only CI evidence.
   *
   * @param {object} input evidence values
   * @param {string} [input.command] selected literal command
   * @param {string} input.initialization initialization status
   * @param {string} input.transport transport mode
   * @returns {void}
   */
  function completeReview ({ command: selectedCommand = command, initialization, transport }) {
    framework.ciWiring = {
      command: selectedCommand,
      configFile: workflow,
      initialization: { evidence: ['Reviewed the selected job.'], status: initialization },
      job: 'test:',
      reviewComplete: true,
      step: `run: ${selectedCommand}`,
      transport: { evidence: ['Reviewed the selected job.'], mode: transport },
      unresolved: [],
      workingDirectory: fixture.root,
    }
  }
})

/**
 * Creates a minimal literal GitHub Actions workflow.
 *
 * @param {object} input workflow values
 * @param {string} input.command test command
 * @param {string[]} [input.env] job environment lines
 * @returns {string} workflow source
 */
function workflowSource ({ command, env = [] }) {
  return [
    'jobs:',
    '  test:',
    ...(env.length > 0 ? ['    env:', ...env] : []),
    '    steps:',
    `      - run: ${command}`,
    '',
  ].join('\n')
}
