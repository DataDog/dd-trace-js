'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { loadManifest } = require('../../../../ci/test-optimization-validation/manifest-loader')
const { validateManifest } = require('../../../../ci/test-optimization-validation/manifest-schema')
const {
  createLoadedManifest,
  createRepositoryFixture,
  removeFixture,
} = require('./validation-test-helpers')

describe('test optimization validation manifest schema', () => {
  let fixture
  let manifest

  beforeEach(() => {
    fixture = createRepositoryFixture({ framework: 'mocha' })
    manifest = JSON.parse(JSON.stringify(createLoadedManifest(fixture.root, 'mocha')))
    delete manifest.__path
  })

  afterEach(() => removeFixture(fixture.root))

  it('accepts the data-only scaffold', () => {
    assert.deepStrictEqual(validateManifest(manifest), [])
    assert.strictEqual(JSON.stringify(manifest).includes('"argv"'), false)
  })

  it('rejects an unknown blocker category', () => {
    manifest.frameworks[0].blockerCategory = 'SOMETHING_ELSE'

    assert.match(validateManifest(manifest).join('\n'), /blockerCategory must be one of/)
  })

  it('accepts emoji presentation selectors in inert CI labels', () => {
    manifest.frameworks[0].ciWiring.job = 'test'
    manifest.frameworks[0].ciWiring.step = '▶️ Run validate script'

    assert.deepStrictEqual(validateManifest(manifest), [])
  })

  it('continues to reject bidirectional controls in inert CI labels', () => {
    manifest.frameworks[0].ciWiring.step = 'Run\u202Ehidden'

    assert.match(validateManifest(manifest).join('\n'), /unsafe invisible character/)
  })

  it('accepts a detected framework that the validator does not support', () => {
    const unsupported = structuredClone(manifest.frameworks[0])
    unsupported.id = 'karma:root'
    unsupported.framework = 'karma'
    unsupported.status = 'unsupported_by_validator'
    delete unsupported.validation
    delete unsupported.preflight
    delete unsupported.generatedTestStrategy
    manifest.frameworks = [unsupported]

    assert.deepStrictEqual(validateManifest(manifest), [])
  })

  for (const [label, mutate, expected] of [
    [
      'an embedded argv',
      value => { value.frameworks[0].argv = ['npm', 'test'] },
      /argv is not supported/,
    ],
    [
      'an embedded generated command',
      value => { value.frameworks[0].generatedTestStrategy.scenarios[0].runCommand = { shell: 'npm test' } },
      /runCommand is not supported/,
    ],
    [
      'a shell field',
      value => { value.frameworks[0].shellCommand = 'npm test' },
      /shellCommand is not supported/,
    ],
    [
      'a setup recipe',
      value => { value.frameworks[0].setup = { commands: ['npm install'] } },
      /setup is not supported/,
    ],
    [
      'an outside runner',
      value => { value.frameworks[0].validation.runner = path.join(os.tmpdir(), 'outside-runner.js') },
      /validation\.runner must be inside repository\.root/,
    ],
    [
      'an outside test',
      value => { value.frameworks[0].validation.testFile = path.join(os.tmpdir(), 'outside-test.js') },
      /validation\.testFile must be inside repository\.root/,
    ],
    [
      'an outside fallback test',
      value => {
        value.frameworks[0].validation.fallbackTests = [{
          buildArtifactRequired: false,
          localSocketRequired: false,
          testFile: path.join(os.tmpdir(), 'outside-test.js'),
        }]
      },
      /validation\.fallbackTests\[0\]\.testFile must be inside repository\.root/,
    ],
    [
      'an excessive fallback set',
      value => {
        value.frameworks[0].validation.fallbackTests = [1, 2, 3].map(index => ({
          buildArtifactRequired: false,
          localSocketRequired: false,
          testFile: path.join(value.repository.root, 'test', `fallback-${index}.js`),
        }))
      },
      /validation\.fallbackTests must contain at most 2 entries/,
    ],
    [
      'an executable field in fallback metadata',
      value => {
        value.frameworks[0].validation.fallbackTests = [{
          argv: ['npm', 'test'],
          buildArtifactRequired: false,
          localSocketRequired: false,
          testFile: path.join(value.repository.root, 'test', 'fallback.js'),
        }]
      },
      /validation\.fallbackTests\[0\]\.argv is not supported/,
    ],
    [
      'an unsupported selector scope',
      value => { value.frameworks[0].validation.selectorScope = 'unverified_wrapper' },
      /selectorScope must be bounded_direct_runner or instrumented_event_identity/,
    ],
    [
      'an unsupported runner argument',
      value => { value.frameworks[0].validation.runnerArgs = ['--eval', 'process.exit()'] },
      /runnerArgs contain unsupported option --eval/,
    ],
    [
      'runner shell control syntax',
      value => { value.frameworks[0].validation.runnerArgs = ['--require', 'safe; unsafe'] },
      /runnerArgs contain a missing or unsafe value for --require/,
    ],
    [
      'a runner-controlled NODE_OPTIONS value',
      value => { value.frameworks[0].validation.environment = { NODE_OPTIONS: '--require ./unsafe.js' } },
      /environment contains unsupported variable NODE_OPTIONS/,
    ],
    [
      'a dynamic runner environment value',
      value => { value.frameworks[0].validation.environment = { NODE_ENV: '$NODE_ENV' } },
      /environment contains an unsafe value for NODE_ENV/,
    ],
    [
      'a Datadog environment dependency',
      value => { value.frameworks[0].validation.requiredEnvVars = ['DD_API_KEY'] },
      /must not inherit Datadog/,
    ],
    [
      'NODE_OPTIONS inheritance',
      value => { value.frameworks[0].validation.requiredEnvVars = ['NODE_OPTIONS'] },
      /must not inherit Datadog, OpenTelemetry, NODE_OPTIONS, or TS_NODE_PROJECT/,
    ],
    [
      'TS_NODE_PROJECT inheritance',
      value => { value.frameworks[0].validation.requiredEnvVars = ['TS_NODE_PROJECT'] },
      /must not inherit Datadog, OpenTelemetry, NODE_OPTIONS, or TS_NODE_PROJECT/,
    ],
    [
      'secret environment inheritance',
      value => { value.frameworks[0].validation.requiredEnvVars = ['NPM_TOKEN'] },
      /must not inherit secret-like environment variables/,
    ],
    [
      'executable-loading environment inheritance',
      value => { value.frameworks[0].validation.requiredEnvVars = ['NODE_PATH'] },
      /must not inherit executable-loading environment variables/,
    ],
    [
      'an excessive timeout',
      value => { value.frameworks[0].validation.timeoutMs = 1_800_001 },
      /timeoutMs must be an integer between/,
    ],
    [
      'rewritten generated source',
      value => { value.frameworks[0].generatedTestStrategy.files[0].contentLines = ['process.exit(0)'] },
      /source differs from the validator-owned mocha recipe/,
    ],
    [
      'a generated file omitted from cleanup',
      value => { value.frameworks[0].generatedTestStrategy.cleanupPaths.shift() },
      /must be included in generatedTestStrategy\.cleanupPaths/,
    ],
    [
      'an executable-shaped CI command',
      value => { value.frameworks[0].ciWiring.command = { argv: ['npm', 'test'] } },
      /ciWiring\.command must be a string or null/,
    ],
    [
      'an outside CI file',
      value => { value.frameworks[0].ciWiring.configFile = path.join(os.tmpdir(), 'workflow.yml') },
      /ciWiring\.configFile must be inside repository\.root/,
    ],
    [
      'a non-boolean review result',
      value => { value.frameworks[0].ciWiring.reviewComplete = 'yes' },
      /reviewComplete must be a boolean/,
    ],
    [
      'a non-boolean shared localhost prerequisite',
      value => { value.frameworks[0].allCandidatesRequireLocalSocket = 'yes' },
      /allCandidatesRequireLocalSocket must be a boolean/,
    ],
    [
      'a non-boolean build prerequisite',
      value => { value.frameworks[0].buildArtifactRequired = 'yes' },
      /buildArtifactRequired must be a boolean/,
    ],
  ]) {
    it(`rejects ${label}`, () => {
      mutate(manifest)
      assert.match(validateManifest(manifest).join('\n'), expected)
    })
  }

  it('rejects generated-path ownership collisions across frameworks', () => {
    const duplicate = structuredClone(manifest.frameworks[0])
    duplicate.id = 'mocha:second'
    manifest.frameworks.push(duplicate)

    assert.match(validateManifest(manifest).join('\n'), /conflicts with another framework/)
  })

  it('rejects a retained preload that is not approval-bound', () => {
    const preload = path.join(fixture.root, 'test', 'preload.js')
    fs.writeFileSync(preload, 'void 0\n')
    manifest.frameworks[0].validation.runnerArgs = ['--require', preload]

    assert.match(validateManifest(manifest).join('\n'), /input that is not approval-bound/)
  })

  it('rejects a retained preload outside the repository', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-outside-loader-')))
    const preload = path.join(outside, 'preload.js')
    fs.writeFileSync(preload, 'void 0\n')
    manifest.frameworks[0].validation.runnerArgs = ['--require', preload]

    try {
      assert.match(validateManifest(manifest).join('\n'), /resolves outside the repository/)
    } finally {
      fs.rmSync(outside, { force: true, recursive: true })
    }
  })

  it('rejects a manifest symlink', () => {
    const manifestPath = path.join(fixture.root, 'dd-test-optimization-validation-manifest.json')
    const linkedPath = path.join(fixture.root, 'linked-manifest.json')
    fs.symlinkSync(manifestPath, linkedPath)

    assert.throws(() => loadManifest(linkedPath), /must be a regular file, not a symbolic link/)
  })

  it('rejects paths that lexically look contained but physically escape', () => {
    const external = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-outside-')))
    const linkedDirectory = path.join(fixture.root, 'linked')
    fs.symlinkSync(external, linkedDirectory, 'dir')
    const escaped = path.join(linkedDirectory, 'runner.js')
    fs.writeFileSync(path.join(external, 'runner.js'), 'process.exit(0)\n')
    manifest.frameworks[0].validation.runner = escaped
    const manifestPath = path.join(fixture.root, 'dd-test-optimization-validation-manifest.json')
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`)

    try {
      assert.throws(() => loadManifest(manifestPath), /validation\.runner resolves outside/)
    } finally {
      fs.rmSync(external, { force: true, recursive: true })
    }
  })
})
