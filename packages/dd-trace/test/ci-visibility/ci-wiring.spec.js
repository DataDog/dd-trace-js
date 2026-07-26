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
    'npx mocha test/example.spec.js',
    'npx --no-install mocha test/example.spec.js',
    'pnpm run test:unit',
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
      assert.match(result.diagnosis, /could not be resolved/)
    })
  }

  for (const wrapped of ['npm test', 'pnpm test', 'pnpm run test', 'yarn test', 'yarn run test']) {
    it(`resolves a local package script without executing it: ${wrapped}`, () => {
      fs.writeFileSync(workflow, workflowSource({ command: wrapped }))
      completeReview({ command: wrapped, initialization: 'not_configured', transport: 'none' })
      const result = runCiWiring({ framework, manifest })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.ciFacts.runnerInvocation.status, 'confirmed')
      assert.strictEqual(result.evidence.ciFacts.runnerInvocation.source, 'local_package_script')
      assert.match(result.evidence.ciFacts.runnerInvocation.resolvedCommand, /mocha/)
    })
  }

  it('resolves recursive local scripts and an inert coverage launcher', () => {
    writeScripts({
      test: 'npm run test:unit',
      'test:unit': `c8 ${command}`,
    })
    fs.writeFileSync(workflow, workflowSource({ command: 'npm test' }))
    completeReview({ command: 'npm test', initialization: 'not_configured', transport: 'none' })
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'fail')
    assert.deepStrictEqual(
      result.evidence.ciFacts.runnerInvocation.commandPath,
      ['npm test', 'npm run test:unit', `c8 ${command}`]
    )
  })

  it('resolves coverage-wrapped package scripts and literal cross-env assignments', () => {
    writeScripts({
      'test-ci': 'AJV_FULL_TEST=true npm test',
      test: 'npm run prepare-tests && npm run test-cov',
      'prepare-tests': 'node ./scripts/prepare.js',
      'test-cov': 'nyc npm run test-spec',
      'test-spec': `cross-env TS_NODE_PROJECT=test/tsconfig.json ${command}`,
    })
    fs.writeFileSync(workflow, workflowSource({ command: 'npm run test-ci' }))
    completeReview({ command: 'npm run test-ci', initialization: 'not_configured', transport: 'none' })
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'fail')
    assert.match(result.evidence.ciFacts.runnerInvocation.resolvedCommand, /^cross-env .*mocha/)
  })

  it('finds a framework invoked from an npm lifecycle script', () => {
    framework.framework = 'cucumber'
    framework.id = 'cucumber:fixture'
    writeScripts({
      pretest: 'npm run conformance',
      test: command,
      conformance: 'cucumber-js ./features/example.feature -p default',
    })
    fs.writeFileSync(workflow, workflowSource({ command: 'npm test' }))
    completeReview({ command: 'npm test', initialization: 'not_configured', transport: 'none' })
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'fail')
    assert.match(result.evidence.ciFacts.runnerInvocation.resolvedCommand, /^cucumber-js/)
    assert.deepStrictEqual(result.evidence.ciFacts.runnerInvocation.lifecycleScripts, ['pretest'])
  })

  it('does not assume implicit lifecycle semantics for Yarn', () => {
    framework.framework = 'cucumber'
    framework.id = 'cucumber:fixture'
    writeScripts({
      pretest: 'cucumber-js ./features/example.feature -p default',
      test: command,
    })
    fs.writeFileSync(workflow, workflowSource({ command: 'yarn test' }))
    completeReview({ command: 'yarn test', initialization: 'not_configured', transport: 'none' })
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.ciFacts.runnerInvocation.status, 'unresolved')
  })

  it('does not let local lifecycle scripts or a plain Node matrix block a confirmed finding', () => {
    writeScripts({
      pretest: 'node ./scripts/build.js',
      test: command,
      posttest: 'node ./scripts/cleanup.js',
    })
    fs.writeFileSync(workflow, matrixWorkflowSource({ command: 'npm test' }))
    completeReview({
      command: 'npm test',
      initialization: 'not_configured',
      reviewComplete: false,
      transport: 'none',
      unresolved: [
        'npm lifecycle scripts',
        'Node version matrix',
        'Repository and organization secrets may inject Datadog configuration outside the workflow.',
        'Other jobs also run npm test; only the test job was selected.',
      ],
    })
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'fail')
    assert.deepStrictEqual(
      result.evidence.ciFacts.runnerInvocation.lifecycleScripts,
      ['pretest', 'posttest']
    )
    assert.strictEqual(result.evidence.ciFacts.matrix.status, 'not_relevant_to_ci_facts')
    assert.deepStrictEqual(result.evidence.ciFacts.unresolved.relevant, [])
  })

  it('keeps a matrix-selected package script incomplete while retaining the initialization fact', () => {
    const selectedCommand = 'npm run test:$' + '{{ matrix.suite }}'
    fs.writeFileSync(workflow, matrixWorkflowSource({ command: selectedCommand }))
    completeReview({
      command: selectedCommand,
      initialization: 'not_configured',
      reviewComplete: false,
      transport: 'none',
      unresolved: ['The matrix selects the package script.'],
    })
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.ciFacts.initialization.status, 'missing')
    assert.strictEqual(result.evidence.ciFacts.runnerInvocation.status, 'unresolved')
    assert.strictEqual(result.evidence.ciFacts.matrix.status, 'affects_relevant_configuration')
    assert.match(result.diagnosis, /no visible dd-trace\/ci\/init/)
  })

  it('keeps bracket-form matrices that affect CI configuration unresolved', () => {
    fs.writeFileSync(workflow, bracketMatrixWorkflowSource({ command: 'npm test' }))
    completeReview({
      command: 'npm test',
      initialization: 'not_configured',
      reviewComplete: false,
      transport: 'none',
      unresolved: ['The matrix selects the working directory.'],
    })
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.ciFacts.matrix.status, 'affects_relevant_configuration')
    assert.deepStrictEqual(result.evidence.ciFacts.unresolved.relevant, [
      'The matrix selects the working directory.',
    ])
  })

  it('keeps opaque inherited configuration relevant after resolving the local package script', () => {
    fs.writeFileSync(workflow, workflowSource({ command: 'npm test' }))
    completeReview({
      command: 'npm test',
      initialization: 'not_configured',
      reviewComplete: false,
      transport: 'none',
      unresolved: ['A remote action may write NODE_OPTIONS through GITHUB_ENV.'],
    })
    const result = runCiWiring({ framework, manifest })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.ciFacts.initialization.status, 'missing')
    assert.strictEqual(result.evidence.ciFacts.runnerInvocation.status, 'confirmed')
    assert.deepStrictEqual(result.evidence.ciFacts.unresolved.relevant, [
      'A remote action may write NODE_OPTIONS through GITHUB_ENV.',
    ])
  })

  it('fails closed for cyclic or dynamic local package scripts', () => {
    for (const scripts of [
      { test: 'npm run test:unit', 'test:unit': 'npm test' },
      { test: 'NODE_OPTIONS=$NODE_OPTIONS mocha test/example.spec.js' },
      { test: `NODE_OPTIONS="" && ${command}` },
    ]) {
      writeScripts(scripts)
      fs.writeFileSync(workflow, workflowSource({ command: 'npm test' }))
      completeReview({ command: 'npm test', initialization: 'not_configured', transport: 'none' })
      const result = runCiWiring({ framework, manifest })

      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.ciFacts.runnerInvocation.status, 'unresolved')
      assert.match(result.evidence.ciFacts.runnerInvocation.reason, /cycle|dynamic shell syntax|stateful shell/)
    }
  })

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
    assert.match(result.diagnosis, /overrides NODE_OPTIONS/)
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
    assert.strictEqual(result.evidence.ciFacts.transport.status, 'credentials_unverified')
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
   * @param {boolean} [input.reviewComplete] whether relevant review is complete
   * @param {string} input.transport transport mode
   * @param {string[]} [input.unresolved] unresolved CI evidence
   * @returns {void}
   */
  function completeReview ({
    command: selectedCommand = command,
    initialization,
    reviewComplete = true,
    transport,
    unresolved = [],
  }) {
    framework.ciWiring = {
      command: selectedCommand,
      configFile: workflow,
      initialization: { evidence: ['Reviewed the selected job.'], status: initialization },
      job: 'test:',
      reviewComplete,
      step: `run: ${selectedCommand}`,
      transport: { evidence: ['Reviewed the selected job.'], mode: transport },
      unresolved,
      workingDirectory: fixture.root,
    }
  }

  function writeScripts (scripts) {
    const filename = path.join(fixture.root, 'package.json')
    const packageJson = JSON.parse(fs.readFileSync(filename))
    packageJson.scripts = scripts
    fs.writeFileSync(filename, `${JSON.stringify(packageJson)}\n`)
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

function matrixWorkflowSource ({ command }) {
  return [
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    strategy:',
    '      matrix:',
    '        node: [18, 20, 22]',
    '    steps:',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: $' + '{{ matrix.node }}',
    `      - run: ${command}`,
    '',
  ].join('\n')
}

function bracketMatrixWorkflowSource ({ command }) {
  return [
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    strategy:',
    '      matrix:',
    "        working-directory: ['.', packages/app]",
    '    defaults:',
    '      run:',
    '        working-directory: $' + '{{ matrix[\'working-directory\'] }}',
    '    steps:',
    `      - run: ${command}`,
    '',
  ].join('\n')
}
