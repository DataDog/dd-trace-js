'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runCiWiring } = require('../../../../ci/test-optimization-validation/scenarios/ci-wiring')

function getFramework (overrides = {}) {
  return {
    id: 'vitest:unit',
    framework: 'vitest',
    project: { name: 'fixture', root: process.cwd() },
    existingTestCommand: {
      cwd: process.cwd(),
      argv: ['npm', 'test'],
    },
    ciWiring: {
      provider: 'github-actions',
      configFile: path.join(process.cwd(), '.github/workflows/test.yml'),
      job: 'test',
      step: 'Run tests',
      command: 'npm test',
      unresolved: [],
      initialization: {
        status: 'unknown',
        evidence: [],
      },
      transport: { mode: 'unknown', evidence: [] },
    },
    ...overrides,
  }
}

function getManifest (root = process.cwd()) {
  return { repository: { root } }
}

function withPackageScriptAudit ({ script, chain = [script], shell, unresolved = [] }, assertion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-ci-audit-'))
  const packageJson = path.join(root, 'package.json')
  fs.writeFileSync(packageJson, JSON.stringify({ scripts: { test: script } }))
  const framework = getFramework({ project: { name: 'fixture', root } })
  framework.ciWiring.packageScriptExpansionChain = chain
  framework.ciWiring.shell = shell
  framework.ciWiring.unresolved = unresolved
  framework.ciWiring.initialization = {
    status: 'configured',
    evidence: ['The selected CI job configures dd-trace/ci/init.'],
  }
  framework.ciWiring.transport = {
    mode: 'agent',
    evidence: ['The selected CI job declares a Datadog Agent sidecar.'],
  }

  try {
    assertion({
      framework,
      packageJson,
      result: runCiWiring({ manifest: getManifest(root), framework }),
      root,
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe('test optimization CI configuration audit', () => {
  it('confirms that an identified CI job does not initialize Test Optimization', () => {
    const framework = getFramework()
    framework.ciWiring.initialization = {
      status: 'not_configured',
      evidence: ['The selected test step does not set NODE_OPTIONS.'],
    }

    const result = runCiWiring({ manifest: getManifest(), framework, basicResult: { status: 'pass' } })

    assert.strictEqual(result.status, 'fail')
    assert.strictEqual(result.evidence.conclusion, 'confirmed_misconfigured')
    assert.strictEqual(result.evidence.domain, 'ci_configuration')
    assert.match(result.diagnosis, /no project CI command was run/)
  })

  it('does not claim a test job was identified from a workflow-wide scan', () => {
    const framework = getFramework()
    delete framework.ciWiring.job
    delete framework.ciWiring.step
    framework.ciWiring.initialization = {
      status: 'not_configured',
      evidence: ['No discovered CI configuration references dd-trace/ci/init.'],
    }

    const result = runCiWiring({ manifest: getManifest(), framework, basicResult: { status: 'pass' } })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'incomplete')
    assert.match(result.diagnosis, /did not resolve the complete test job and wrapper chain/)
    assert.match(result.diagnosis, /missing test job/)
  })

  it('keeps CI evidence incomplete when it points to a different monorepo project', () => {
    const root = path.join(process.cwd(), 'fixture-repository')
    const framework = getFramework({
      project: {
        name: '@example/playground',
        root: path.join(root, 'compiler', 'apps', 'playground'),
        configFiles: [path.join(root, 'compiler', 'apps', 'playground', 'jest.config.js')],
      },
    })
    framework.ciWiring = {
      ...framework.ciWiring,
      command: 'yarn test fixtures/flight',
      workingDirectory: root,
      wrapperChain: ['yarn test fixtures/flight', 'jest fixtures/flight'],
      initialization: {
        status: 'not_configured',
        evidence: ['The selected job does not set NODE_OPTIONS.'],
      },
    }

    const result = runCiWiring({
      manifest: { repository: { root } },
      framework,
      basicResult: { status: 'pass' },
    })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'incomplete')
    assert.strictEqual(result.evidence.representativeMatch.matched, false)
    assert.match(result.diagnosis, /do not reference selected project compiler\/apps\/playground/)
  })

  it('keeps an unrelated repository-root CI job incomplete', () => {
    const root = process.cwd()
    const framework = getFramework({
      project: { name: 'fixture', root, configFiles: [path.join(root, 'vitest.config.js')] },
    })
    framework.ciWiring.command = 'npm run lint'
    framework.ciWiring.wrapperChain = ['eslint .']
    framework.ciWiring.initialization = {
      status: 'not_configured',
      evidence: ['The lint step does not set NODE_OPTIONS.'],
    }

    const result = runCiWiring({ manifest: { repository: { root } }, framework })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'incomplete')
    assert.strictEqual(result.evidence.ciRemediation, undefined)
    assert.match(result.diagnosis, /not anchored to a structurally proven test command/)
  })

  it('keeps an unrelated nested-project CI job incomplete even when its working directory matches', () => {
    const root = path.join(process.cwd(), 'fixture-repository')
    const projectRoot = path.join(root, 'packages', 'example')
    const framework = getFramework({
      project: {
        name: '@example/package',
        root: projectRoot,
        configFiles: [path.join(projectRoot, 'vitest.config.js')],
      },
    })
    framework.ciWiring = {
      ...framework.ciWiring,
      command: 'npm run lint',
      workingDirectory: projectRoot,
      wrapperChain: ['npm run lint', 'eslint .'],
      initialization: {
        status: 'not_configured',
        evidence: ['The selected lint job does not set NODE_OPTIONS.'],
      },
    }

    const result = runCiWiring({
      manifest: { repository: { root } },
      framework,
      basicResult: { status: 'pass' },
    })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'incomplete')
    assert.strictEqual(result.evidence.representativeMatch.matched, false)
    assert.strictEqual(result.evidence.ciRemediation, undefined)
    assert.match(result.diagnosis, /not anchored to a structurally proven test command/)
  })

  it('keeps a selected package script incomplete when its resolved wrapper ends in a non-test command', () => {
    const framework = getFramework()
    framework.ciWiring.wrapperChain = ['npm test', 'eslint .']
    framework.ciWiring.initialization = {
      status: 'not_configured',
      evidence: ['The selected job does not set NODE_OPTIONS.'],
    }

    const result = runCiWiring({ manifest: getManifest(), framework })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'incomplete')
    assert.strictEqual(result.evidence.ciRemediation, undefined)
    assert.strictEqual(result.evidence.representativeMatch.matched, false)
    assert.match(result.diagnosis, /not anchored to a structurally proven test command/)
  })

  for (const [name, command, wrapperChain] of [
    ['a different package script that only names Vitest', 'npm run vitest:lint', ['eslint .']],
    ['an echoed selected package script', 'echo npm test', []],
    ['an echoed runner command', 'echo vitest run', []],
    ['a lint command naming the runner configuration', 'eslint vitest.config.js', []],
    ['a command naming only the representative test', 'cat test/example.test.js', []],
  ]) {
    it(`keeps ${name} incomplete`, () => {
      const root = process.cwd()
      const framework = getFramework({
        project: {
          name: 'fixture',
          root,
          configFiles: [path.join(root, 'vitest.config.js')],
        },
        localTestCandidates: [{ sourceFile: path.join(root, 'test', 'example.test.js') }],
      })
      framework.ciWiring.command = command
      framework.ciWiring.wrapperChain = wrapperChain
      framework.ciWiring.packageScriptExpansionChain = wrapperChain
      framework.ciWiring.initialization = {
        status: 'not_configured',
        evidence: ['The selected job does not set NODE_OPTIONS.'],
      }

      const result = runCiWiring({ manifest: getManifest(root), framework })

      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.conclusion, 'incomplete')
      assert.strictEqual(result.evidence.evidenceStrength, 'unknown')
      assert.strictEqual(result.evidence.ciRemediation, undefined)
      assert.strictEqual(result.evidence.representativeMatch.matched, false)
    })
  }

  for (const [manager, command, argv] of [
    ['npm', 'npm run test', ['npm', 'run', 'test']],
    ['pnpm', 'pnpm test', ['pnpm', 'test']],
    ['Yarn', 'yarn run test', ['yarn', 'run', 'test']],
  ]) {
    it(`accepts the exact selected ${manager} package script`, () => {
      const framework = getFramework({
        existingTestCommand: { cwd: process.cwd(), argv },
      })
      framework.ciWiring.command = command
      framework.ciWiring.initialization = {
        status: 'not_configured',
        evidence: ['The selected job does not set NODE_OPTIONS.'],
      }

      const result = runCiWiring({ manifest: getManifest(), framework })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.conclusion, 'confirmed_misconfigured')
    })
  }

  it('accepts a direct matching runner invocation', () => {
    const framework = getFramework()
    framework.ciWiring.command = 'vitest run test/example.test.js'
    framework.ciWiring.initialization = {
      status: 'not_configured',
      evidence: ['The selected job does not set NODE_OPTIONS.'],
    }

    const result = runCiWiring({ manifest: getManifest(), framework })

    assert.strictEqual(result.status, 'fail')
    assert.strictEqual(result.evidence.conclusion, 'confirmed_misconfigured')
  })

  for (const [name, command] of [
    ['cross-env', 'cross-env NODE_ENV=test vitest run test/example.test.js'],
    ['c8', 'c8 --reporter=text vitest run test/example.test.js'],
    ['nyc', 'nyc --reporter text vitest run test/example.test.js'],
    ['npx', 'npx --yes vitest run test/example.test.js'],
    ['stacked transparent wrappers',
      'cross-env NODE_ENV=test c8 --reporter=text npx --yes vitest run test/example.test.js'],
  ]) {
    it(`accepts a terminal runner linked through ${name}`, () => {
      const framework = getFramework()
      framework.ciWiring.command = command
      framework.ciWiring.workingDirectory = process.cwd()
      framework.ciWiring.wrapperChain = [{ source: 'package script', command }]
      framework.ciWiring.terminalTestCommand = {
        command: 'vitest run test/example.test.js',
        framework: 'vitest',
        projectRoot: process.cwd(),
        mode: 'node',
      }
      framework.ciWiring.initialization = {
        status: 'not_configured',
        evidence: ['The selected job does not set NODE_OPTIONS.'],
      }

      const result = runCiWiring({ manifest: getManifest(), framework })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.conclusion, 'confirmed_misconfigured')
    })
  }

  for (const [name, command] of [
    ['an arbitrary coverage child', 'nyc echo vitest run test/example.test.js'],
    ['an arbitrary cross-env child', 'cross-env NODE_ENV=test node fake.js vitest run test/example.test.js'],
    ['npx source evaluation', 'npx --call vitest run test/example.test.js'],
  ]) {
    it(`keeps terminal runner evidence incomplete through ${name}`, () => {
      const framework = getFramework()
      framework.ciWiring.command = command
      framework.ciWiring.workingDirectory = process.cwd()
      framework.ciWiring.wrapperChain = [{ source: 'package script', command }]
      framework.ciWiring.terminalTestCommand = {
        command: 'vitest run test/example.test.js',
        framework: 'vitest',
        projectRoot: process.cwd(),
        mode: 'node',
      }
      framework.ciWiring.initialization = {
        status: 'not_configured',
        evidence: ['The selected job does not set NODE_OPTIONS.'],
      }

      const result = runCiWiring({ manifest: getManifest(), framework })

      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.conclusion, 'incomplete')
      assert.strictEqual(result.evidence.representativeMatch.matched, false)
    })
  }

  it('accepts a matching nested project with a direct runner invocation', () => {
    const root = path.join(process.cwd(), 'fixture-repository')
    const projectRoot = path.join(root, 'packages', 'example')
    const framework = getFramework({
      project: { name: '@example/package', root: projectRoot, configFiles: [] },
    })
    framework.ciWiring.command = 'vitest run'
    framework.ciWiring.workingDirectory = projectRoot
    framework.ciWiring.initialization = {
      status: 'not_configured',
      evidence: ['The selected job does not set NODE_OPTIONS.'],
    }

    const result = runCiWiring({ manifest: getManifest(root), framework })

    assert.strictEqual(result.status, 'fail')
    assert.strictEqual(result.evidence.conclusion, 'confirmed_misconfigured')
  })

  it('does not infer a Vitest mode mismatch without local mode evidence', () => {
    const root = process.cwd()
    const configFile = path.join(root, 'vitest.browser.config.js')
    const framework = getFramework({
      status: 'requires_manual_setup',
      project: { name: 'fixture', root, configFiles: [configFile] },
      existingTestCommand: undefined,
    })
    framework.ciWiring.command = 'vitest --browser --config vitest.browser.config.js'
    framework.ciWiring.initialization = {
      status: 'not_configured',
      evidence: ['The browser test step does not set NODE_OPTIONS.'],
    }

    const result = runCiWiring({ manifest: { repository: { root } }, framework })

    assert.strictEqual(result.status, 'fail')
    assert.strictEqual(result.evidence.conclusion, 'confirmed_misconfigured')
    assert.strictEqual(result.evidence.representativeMatch, undefined)
    assert.doesNotMatch(result.diagnosis, /different Vitest browser\/Node mode/)
  })

  it('accepts a structured terminal test command reached through a monorepo wrapper', () => {
    const root = path.join(process.cwd(), 'fixture-repository')
    const projectRoot = path.join(root, 'pkgs', 'core')
    const framework = getFramework({
      project: { name: 'date-fns', root: projectRoot, configFiles: [] },
    })
    framework.ciWiring = {
      ...framework.ciWiring,
      command: 'mise //pkgs/core:test/node',
      workingDirectory: root,
      wrapperChain: [
        {
          source: '.github/workflows/test.yml job test',
          command: 'mise //pkgs/core:test/node',
          workingDirectory: root,
        },
        {
          source: 'mise task //pkgs/core:test/node',
          command: 'mise x node@22 -- pnpm vitest run --project main',
          workingDirectory: projectRoot,
        },
      ],
      terminalTestCommand: {
        command: 'pnpm vitest run --project main',
        framework: 'vitest',
        projectRoot,
        mode: 'node',
      },
      initialization: {
        status: 'not_configured',
        evidence: ['The selected job does not set NODE_OPTIONS.'],
      },
    }

    const result = runCiWiring({
      manifest: { repository: { root } },
      framework,
      basicResult: { status: 'pass' },
    })

    assert.strictEqual(result.status, 'fail')
    assert.strictEqual(result.evidence.conclusion, 'confirmed_misconfigured')
  })

  it('keeps an unlinked structured terminal test command incomplete', () => {
    const root = path.join(process.cwd(), 'fixture-repository')
    const projectRoot = path.join(root, 'pkgs', 'core')
    const framework = getFramework({
      project: { name: 'date-fns', root: projectRoot, configFiles: [] },
    })
    framework.ciWiring = {
      ...framework.ciWiring,
      command: 'mise //pkgs/core:test/node',
      workingDirectory: root,
      wrapperChain: [{
        source: 'mise task //pkgs/core:test/node',
        command: 'mise x node@22 -- pnpm lint',
        workingDirectory: projectRoot,
      }],
      terminalTestCommand: {
        command: 'pnpm vitest run --project main',
        framework: 'vitest',
        projectRoot,
        mode: 'node',
      },
      initialization: {
        status: 'not_configured',
        evidence: ['The selected job does not set NODE_OPTIONS.'],
      },
    }

    const result = runCiWiring({
      manifest: { repository: { root } },
      framework,
      basicResult: { status: 'pass' },
    })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'incomplete')
    assert.strictEqual(result.evidence.representativeMatch.matched, false)
    assert.match(result.diagnosis, /not anchored to a structurally proven test command/)
  })

  it('does not accept an echoed terminal test command as wrapper linkage', () => {
    const root = path.join(process.cwd(), 'fixture-repository')
    const projectRoot = path.join(root, 'pkgs', 'core')
    const framework = getFramework({
      project: { name: 'date-fns', root: projectRoot, configFiles: [] },
    })
    framework.ciWiring = {
      ...framework.ciWiring,
      command: 'mise //pkgs/core:test/node',
      workingDirectory: root,
      wrapperChain: [{
        source: 'mise task //pkgs/core:test/node',
        command: 'echo pnpm vitest run --project main',
        workingDirectory: projectRoot,
      }],
      terminalTestCommand: {
        command: 'pnpm vitest run --project main',
        framework: 'vitest',
        projectRoot,
        mode: 'node',
      },
      initialization: {
        status: 'not_configured',
        evidence: ['The selected job does not set NODE_OPTIONS.'],
      },
    }

    const result = runCiWiring({
      manifest: { repository: { root } },
      framework,
      basicResult: { status: 'pass' },
    })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'incomplete')
    assert.strictEqual(result.evidence.representativeMatch.matched, false)
  })

  it('keeps CI evidence incomplete when it selects browser mode for a Node Vitest representative', () => {
    const root = path.join(process.cwd(), 'fixture-repository')
    const framework = getFramework({
      project: {
        name: 'date-fns',
        root: path.join(root, 'pkgs', 'core'),
        configFiles: [path.join(root, 'pkgs', 'core', 'vitest.config.ts')],
      },
      existingTestCommand: {
        cwd: path.join(root, 'pkgs', 'core'),
        argv: ['node', 'node_modules/vitest/vitest.mjs', 'run', 'src/example/test.ts'],
      },
    })
    framework.ciWiring = {
      ...framework.ciWiring,
      command: 'mise //pkgs/core:test/browser',
      workingDirectory: root,
      wrapperChain: ['mise //pkgs/core:test/browser', 'pnpm vitest run --browser'],
      initialization: {
        status: 'not_configured',
        evidence: ['The selected job does not set NODE_OPTIONS.'],
      },
    }

    const result = runCiWiring({
      manifest: { repository: { root } },
      framework,
      basicResult: { status: 'pass' },
    })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'incomplete')
    assert.strictEqual(result.evidence.representativeMatch.matched, false)
    assert.match(result.diagnosis, /different Vitest browser\/Node mode/)
  })

  it('keeps missing initialization inconclusive while reusable configuration remains unresolved', () => {
    const framework = getFramework()
    framework.ciWiring.initialization = {
      status: 'not_configured',
      evidence: ['The selected workflow has no direct NODE_OPTIONS assignment.'],
    }
    framework.ciWiring.unresolved = ['Reusable workflow org/ci/.github/workflows/test.yml was not available locally.']

    const result = runCiWiring({ manifest: getManifest(), framework, basicResult: { status: 'pass' } })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'incomplete')
    assert.match(result.diagnosis, /Reusable workflow .* was not available locally/)
    assert.match(result.diagnosis, /No confirmed CI misconfiguration was reported/)
  })

  for (const [name, configure] of [
    ['agentless reporting without an API key', framework => {
      framework.ciWiring.stepEnv = { DD_CIVISIBILITY_AGENTLESS_ENABLED: 'true' }
    }],
    ['initialization without a reporting transport', () => {}],
  ]) {
    it(`keeps ${name} inconclusive while inherited configuration remains unresolved`, () => {
      const framework = getFramework()
      framework.ciWiring.initialization = {
        status: 'configured',
        evidence: ['NODE_OPTIONS includes dd-trace/ci/init.'],
      }
      framework.ciWiring.unresolved = ['Inherited organization environment was not available locally.']
      configure(framework)

      const result = runCiWiring({ manifest: getManifest(), framework })

      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.conclusion, 'incomplete')
      assert.match(result.diagnosis, /Inherited organization environment was not available locally/)
      assert.match(result.diagnosis, /No confirmed CI misconfiguration was reported/)
    })
  }

  it('reports configured agentless CI as propagation-unverified', () => {
    const framework = getFramework()
    framework.ciWiring.initialization = {
      status: 'configured',
      evidence: ['NODE_OPTIONS includes dd-trace/ci/init.'],
    }
    framework.ciWiring.stepEnv = { DD_CIVISIBILITY_AGENTLESS_ENABLED: 'true' }
    framework.ciWiring.requiredSecretEnvVars = ['DD_API_KEY']
    framework.ciWiring.transport = {
      mode: 'agentless',
      evidence: ['The selected test step enables agentless reporting.'],
    }

    const result = runCiWiring({ manifest: getManifest(), framework })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'configured_propagation_unverified')
    assert.match(result.diagnosis, /cannot prove that NODE_OPTIONS reaches the final test process/)
  })

  it('recognizes the explicit ci/init.js preload when inferring initialization', () => {
    const framework = getFramework()
    framework.ciWiring.stepEnv = {
      DD_CIVISIBILITY_AGENTLESS_ENABLED: 'true',
      NODE_OPTIONS: '-r dd-trace/ci/init.js',
    }
    framework.ciWiring.requiredSecretEnvVars = ['DD_API_KEY']
    framework.ciWiring.transport = {
      mode: 'agentless',
      evidence: ['The selected test step enables agentless reporting.'],
    }

    const result = runCiWiring({ manifest: getManifest(), framework })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.initializationStatus, 'configured')
    assert.strictEqual(result.evidence.conclusion, 'configured_propagation_unverified')
  })

  it('accepts DATADOG_API_KEY as the agentless API key reference', () => {
    const framework = getFramework()
    framework.ciWiring.initialization = {
      status: 'configured',
      evidence: ['NODE_OPTIONS includes dd-trace/ci/init.'],
    }
    framework.ciWiring.stepEnv = { DD_CIVISIBILITY_AGENTLESS_ENABLED: 'true' }
    framework.ciWiring.requiredSecretEnvVars = ['DATADOG_API_KEY']
    framework.ciWiring.transport = {
      mode: 'agentless',
      evidence: ['The selected test step enables agentless reporting.'],
    }

    const result = runCiWiring({ manifest: getManifest(), framework })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.apiKeyConfigured, true)
    assert.strictEqual(result.evidence.conclusion, 'configured_propagation_unverified')
  })

  it('uses case-insensitive API key environment semantics for Windows CI shells', () => {
    const framework = getFramework()
    framework.ciWiring.shell = 'pwsh'
    framework.ciWiring.initialization = {
      status: 'configured',
      evidence: ['NODE_OPTIONS includes dd-trace/ci/init.'],
    }
    framework.ciWiring.stepEnv = { dd_api_key: 'dd-validation-placeholder' }
    framework.ciWiring.transport = {
      mode: 'agentless',
      evidence: ['The selected test step enables agentless reporting.'],
    }

    const result = runCiWiring({ manifest: getManifest(), framework })

    assert.strictEqual(result.evidence.apiKeyConfigured, true)
    assert.strictEqual(result.evidence.conclusion, 'configured_propagation_unverified')
  })

  it('honors a case-insensitive empty step override of a Windows workflow API key', () => {
    const framework = getFramework()
    framework.ciWiring.shell = 'pwsh'
    framework.ciWiring.initialization = {
      status: 'configured',
      evidence: ['NODE_OPTIONS includes dd-trace/ci/init.'],
    }
    framework.ciWiring.workflowEnv = { DD_API_KEY: 'dd-validation-placeholder' }
    framework.ciWiring.stepEnv = { dd_api_key: '' }
    framework.ciWiring.transport = {
      mode: 'agentless',
      evidence: ['The selected test step enables agentless reporting.'],
    }

    const result = runCiWiring({ manifest: getManifest(), framework })

    assert.strictEqual(result.status, 'fail')
    assert.strictEqual(result.evidence.apiKeyConfigured, false)
  })

  it('fails when agentless reporting has no API key reference', () => {
    const framework = getFramework()
    framework.ciWiring.initialization = {
      status: 'configured',
      evidence: ['NODE_OPTIONS includes dd-trace/ci/init.'],
    }
    framework.ciWiring.stepEnv = { DD_CIVISIBILITY_AGENTLESS_ENABLED: 'true' }
    framework.ciWiring.transport = {
      mode: 'agentless',
      evidence: ['The selected test step enables agentless reporting.'],
    }

    const result = runCiWiring({ manifest: getManifest(), framework })

    assert.strictEqual(result.status, 'fail')
    assert.match(result.diagnosis, /does not record DD_API_KEY/)
  })

  it('keeps configured initialization incomplete when transport is unknown', () => {
    const framework = getFramework()
    framework.ciWiring.initialization = {
      status: 'configured',
      evidence: ['NODE_OPTIONS includes dd-trace/ci/init.'],
    }

    const result = runCiWiring({ manifest: getManifest(), framework })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'incomplete')
    assert.match(result.diagnosis, /reporting transport.*could not be established/)
  })

  it('accepts explicit Agent evidence without requiring agentless variables', () => {
    const framework = getFramework()
    framework.ciWiring.initialization = {
      status: 'configured',
      evidence: ['NODE_OPTIONS includes dd-trace/ci/init.'],
    }
    framework.ciWiring.transport = {
      mode: 'agent',
      evidence: ['The selected job declares a Datadog Agent sidecar.'],
    }

    const result = runCiWiring({ manifest: getManifest(), framework })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'configured_propagation_unverified')
    assert.strictEqual(result.evidence.apiKeyConfigured, false)
  })

  it('fails for confirmed missing transport only with complete CI evidence', () => {
    const framework = getFramework()
    framework.ciWiring.initialization = {
      status: 'configured',
      evidence: ['NODE_OPTIONS includes dd-trace/ci/init.'],
    }
    framework.ciWiring.transport = {
      mode: 'none',
      evidence: ['The selected test job has no Agent service and does not enable agentless reporting.'],
    }

    const result = runCiWiring({ manifest: getManifest(), framework })

    assert.strictEqual(result.status, 'fail')
    assert.strictEqual(result.evidence.conclusion, 'confirmed_misconfigured')
    assert.match(result.diagnosis, /completed CI review confirms/)
  })

  it('uses step environment values ahead of job, workflow, and inherited values', () => {
    const framework = getFramework()
    framework.ciWiring.initialization = { status: 'unknown', evidence: [] }
    framework.ciWiring.inheritedEnv = { NODE_OPTIONS: '--no-warnings' }
    framework.ciWiring.workflowEnv = { NODE_OPTIONS: '--enable-source-maps' }
    framework.ciWiring.jobEnv = { NODE_OPTIONS: '--trace-warnings' }
    framework.ciWiring.stepEnv = { NODE_OPTIONS: '-r dd-trace/ci/init' }
    framework.ciWiring.transport = {
      mode: 'agent',
      evidence: ['The selected job declares a Datadog Agent sidecar.'],
    }

    const result = runCiWiring({ manifest: getManifest(), framework })

    assert.strictEqual(result.evidence.initializationStatus, 'configured')
    assert.strictEqual(result.evidence.conclusion, 'configured_propagation_unverified')
  })

  it('reports a direct CI command that replaces NODE_OPTIONS before the runner starts', () => {
    const framework = getFramework()
    framework.ciWiring.command = "NODE_OPTIONS='' vitest run"
    framework.ciWiring.initialization = {
      status: 'configured',
      evidence: ['The selected CI job configures dd-trace/ci/init.'],
    }
    framework.ciWiring.transport = {
      mode: 'agent',
      evidence: ['The selected CI job declares a Datadog Agent sidecar.'],
    }

    const result = runCiWiring({ manifest: getManifest(), framework })

    assert.strictEqual(result.status, 'fail')
    assert.strictEqual(result.evidence.conclusion, 'confirmed_misconfigured')
    assert.deepStrictEqual(result.evidence.nodeOptionsRemoval, {
      command: "NODE_OPTIONS='' vitest run",
      operation: 'replace',
      replacement: '',
      source: 'the exact CI test command',
    })
  })

  it('does not mistake a framework directory name for the test-runner invocation', () => {
    const framework = getFramework({
      id: 'jest:root',
      framework: 'jest',
    })
    framework.ciWiring.command = 'cd packages/jest && NODE_OPTIONS= npm test'
    framework.ciWiring.workflowEnv = { NODE_OPTIONS: '-r dd-trace/ci/init' }
    framework.ciWiring.initialization = {
      status: 'configured',
      evidence: ['The workflow environment configures dd-trace/ci/init.'],
    }
    framework.ciWiring.transport = {
      mode: 'agent',
      evidence: ['The selected CI job declares a Datadog Agent sidecar.'],
    }

    const result = runCiWiring({ manifest: getManifest(), framework })

    assert.strictEqual(result.status, 'fail')
    assert.strictEqual(result.evidence.conclusion, 'confirmed_misconfigured')
    assert.strictEqual(result.evidence.nodeOptionsRemoval.replacement, '')
    assert.strictEqual(result.evidence.nodeOptionsRemoval.source, 'the exact CI test command')
  })

  it('reports a lower-scope NODE_OPTIONS value that replaces a workflow preload', () => {
    const framework = getFramework()
    framework.ciWiring.workflowEnv = { NODE_OPTIONS: '-r dd-trace/ci/init' }
    framework.ciWiring.stepEnv = { NODE_OPTIONS: '--experimental-vm-modules' }
    framework.ciWiring.initialization = {
      status: 'configured',
      evidence: ['The workflow environment configures dd-trace/ci/init.'],
    }
    framework.ciWiring.transport = {
      mode: 'agent',
      evidence: ['The selected CI job declares a Datadog Agent sidecar.'],
    }

    const result = runCiWiring({ manifest: getManifest(), framework })

    assert.strictEqual(result.status, 'fail')
    assert.strictEqual(result.evidence.conclusion, 'confirmed_misconfigured')
    assert.strictEqual(result.evidence.nodeOptionsRemoval.replacement, '--experimental-vm-modules')
    assert.strictEqual(result.evidence.nodeOptionsRemoval.source, 'the CI step environment')
    assert.match(result.diagnosis, /CI step environment/)
  })

  for (const script of [
    "NODE_OPTIONS='' vitest run",
    'NODE_OPTIONS="" vitest run',
    'env NODE_OPTIONS= vitest run',
    'unset NODE_OPTIONS; vitest run',
    'env -u NODE_OPTIONS vitest run',
    'echo vitest run; NODE_OPTIONS= vitest run',
  ]) {
    it(`reports NODE_OPTIONS removal from ${JSON.stringify(script)}`, () => {
      withPackageScriptAudit({ script }, ({ packageJson, result }) => {
        assert.strictEqual(result.status, 'fail')
        assert.strictEqual(result.evidence.conclusion, 'confirmed_misconfigured')
        assert.deepStrictEqual(result.evidence.nodeOptionsRemoval, {
          command: script,
          operation: 'replace',
          packageJson,
          replacement: '',
          scriptName: 'test',
        })
        assert.match(result.diagnosis, /script `test`/)
        assert.match(result.diagnosis, /replaces `NODE_OPTIONS` with an empty value/)
        assert.match(result.evidence.recommendation, /Script `test`/)
        assert.match(result.evidence.recommendation, /empty value/)
      })
    })
  }

  it('reports a non-empty NODE_OPTIONS replacement without the Datadog preload', () => {
    const script = 'NODE_OPTIONS=--experimental-vm-modules vitest run'
    withPackageScriptAudit({ script }, ({ packageJson, result }) => {
      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.conclusion, 'confirmed_misconfigured')
      assert.deepStrictEqual(result.evidence.nodeOptionsRemoval, {
        command: script,
        operation: 'replace',
        packageJson,
        replacement: '--experimental-vm-modules',
        scriptName: 'test',
      })
      assert.match(result.diagnosis, /replaces `NODE_OPTIONS` with `--experimental-vm-modules`/)
      assert.match(result.evidence.recommendation, /`--experimental-vm-modules`/)
    })
  })

  it('accepts a literal NODE_OPTIONS replacement containing the Datadog preload', () => {
    const script = "NODE_OPTIONS='--experimental-vm-modules -r dd-trace/ci/init' vitest run"
    withPackageScriptAudit({ script }, ({ result }) => {
      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.nodeOptionsRemoval, undefined)
      assert.strictEqual(result.evidence.nodeOptionsPropagation.status, 'restored')
      assert.strictEqual(result.evidence.conclusion, 'configured_propagation_unverified')
    })
  })

  for (const nodeOptions of [
    '-r "dd-trace/ci/init.js"',
    '--require="/opt/project/node_modules/dd-trace/ci/init.js"',
    '-r "C:\\project\\node_modules\\dd-trace\\ci\\init.js"',
  ]) {
    it(`accepts the valid Datadog preload spelling ${JSON.stringify(nodeOptions)}`, () => {
      const script = `NODE_OPTIONS='${nodeOptions}' vitest run`
      withPackageScriptAudit({ script }, ({ result }) => {
        assert.strictEqual(result.status, 'error')
        assert.strictEqual(result.evidence.nodeOptionsRemoval, undefined)
        assert.strictEqual(result.evidence.nodeOptionsPropagation.status, 'restored')
        assert.strictEqual(result.evidence.conclusion, 'configured_propagation_unverified')
      })
    })
  }

  it('rejects a bare dd-trace initialization path without a Node.js preload option', () => {
    const script = 'NODE_OPTIONS=dd-trace/ci/init vitest run'
    withPackageScriptAudit({ script }, ({ result }) => {
      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.conclusion, 'confirmed_misconfigured')
      assert.strictEqual(result.evidence.nodeOptionsPropagation.status, 'removed')
      assert.strictEqual(result.evidence.nodeOptionsRemoval.replacement, 'dd-trace/ci/init')
    })
  })

  it('keeps a dynamic inherited NODE_OPTIONS replacement inconclusive', () => {
    const script = 'NODE_OPTIONS="$NODE_OPTIONS --experimental-vm-modules" vitest run'
    withPackageScriptAudit({ script }, ({ result }) => {
      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.nodeOptionsRemoval, undefined)
      assert.strictEqual(result.evidence.nodeOptionsPropagation.status, 'unknown')
      assert.strictEqual(result.evidence.conclusion, 'incomplete')
      assert.strictEqual(result.evidence.evidenceStrength, 'unknown')
      assert.match(result.diagnosis, /dynamic NODE_OPTIONS expression/)
    })
  })

  it('respects a later literal restoration of the Datadog preload', () => {
    const script = 'NODE_OPTIONS= npm run inner'
    const restoration = "NODE_OPTIONS='-r dd-trace/ci/init' vitest run"
    withPackageScriptAudit({ script, chain: [script, restoration] }, ({ result }) => {
      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.nodeOptionsRemoval, undefined)
      assert.strictEqual(result.evidence.nodeOptionsPropagation.status, 'restored')
      assert.strictEqual(result.evidence.nodeOptionsPropagation.command, restoration)
      assert.strictEqual(result.evidence.conclusion, 'configured_propagation_unverified')
    })
  })

  it('detects supported Windows and PowerShell NODE_OPTIONS removals', () => {
    for (const [shell, script] of [
      ['cmd.exe', 'set "NODE_OPTIONS=--experimental-vm-modules" && vitest run'],
      ['pwsh', "$env:NODE_OPTIONS = ''; vitest run"],
    ]) {
      withPackageScriptAudit({ script, shell }, ({ result }) => {
        assert.strictEqual(result.status, 'fail')
        assert.strictEqual(result.evidence.conclusion, 'confirmed_misconfigured')
        assert.strictEqual(result.evidence.nodeOptionsRemoval.replacement,
          script.includes('experimental') ? '--experimental-vm-modules' : '')
      })
    }
  })

  it('keeps an explicit NODE_OPTIONS replacement inconclusive while the wrapper chain remains unresolved', () => {
    const script = 'NODE_OPTIONS=--experimental-vm-modules vitest run'
    withPackageScriptAudit({
      script,
      unresolved: ['The Nx target executor configuration was not resolved.'],
    }, ({ result }) => {
      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.conclusion, 'incomplete')
      assert.ok(result.evidence.nodeOptionsRemoval)
      assert.strictEqual(result.evidence.ciRemediation, undefined)
      assert.match(result.diagnosis, /Nx target executor configuration was not resolved/)
    })
  })

  it('keeps contradictory CI discovery incomplete', () => {
    const framework = getFramework()
    framework.ciWiring.provider = 'none'
    framework.ciWiring.diagnosis = 'No CI workflow was found.'

    const result = runCiWiring({
      manifest: {
        repository: { root: process.cwd() },
        ciDiscovery: { staticFound: ['.github/workflows/test.yml'] },
      },
      framework,
    })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.conclusion, 'incomplete')
    assert.match(result.diagnosis, /CI workflow files were found/)
  })

  it('audits CI without depending on a Basic Reporting result', () => {
    const framework = getFramework()
    framework.ciWiring.initialization = {
      status: 'not_configured',
      evidence: ['The selected test step does not set NODE_OPTIONS.'],
    }

    const result = runCiWiring({
      manifest: getManifest(),
      framework,
      basicResult: { status: 'error', diagnosis: 'Project setup failed.' },
    })

    assert.strictEqual(result.status, 'fail')
    assert.strictEqual(result.evidence.directInitializationBasicReporting, undefined)
  })
})
