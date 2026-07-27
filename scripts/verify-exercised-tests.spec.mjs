import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it } from 'mocha'

const SCRIPT = fileURLToPath(new URL('verify-exercised-tests.js', import.meta.url))

// Written split so the linter does not read these as unintended template literals.
const PLUGINS_VAR = '$' + '{PLUGINS}'
const SPEC_VAR = '$' + '{SPEC:-*}'
const MATRIX_SPEC = '$' + '{{ matrix.spec }}'

/**
 * @typedef {{ run: string, env?: Record<string, string> } | { uses: string }} WorkflowStep
 * @typedef {Array<string|WorkflowStep>} JobSteps
 * @typedef {JobSteps | {
 *   steps: JobSteps,
 *   env?: Record<string, string>,
 *   matrix?: Record<string, string[]>,
 * }} WorkflowJob
 * @typedef {{
 *   scripts: Record<string, string>,
 *   workflows: Record<string, Record<string, WorkflowJob>|string>,
 *   files: string[],
 *   actions: Record<string, JobSteps|string>,
 * }} Fixture Workflows and actions accept raw YAML so malformed shapes stay expressible.
 */

/**
 * Baseline checkout that satisfies every check. Each case below overrides one part of it, so a
 * failing assertion points at the single mutation under test rather than at fixture drift.
 *
 * @type {Fixture}
 */
const PASSING = {
  scripts: {
    'test:unit:ci': 'mocha "packages/**/test/**/*.spec.js"',
  },
  workflows: {
    'test.yml': { unit: ['npm run test:unit:ci'] },
  },
  files: ['packages/alpha/test/one.spec.js'],
  actions: {},
}

/**
 * @param {JobSteps} steps
 * @param {string} indent
 * @returns {string[]}
 */
function stepLines (steps, indent) {
  const lines = []

  for (const step of steps) {
    const normalized = typeof step === 'string' ? { run: step } : step

    if ('uses' in normalized) {
      lines.push(`${indent}- uses: ${normalized.uses}`)
      continue
    }

    lines.push(`${indent}- run: ${normalized.run}`)
    if (normalized.env) {
      lines.push(`${indent}  env:`)
      for (const [name, value] of Object.entries(normalized.env)) {
        lines.push(`${indent}    ${name}: ${value}`)
      }
    }
  }

  return lines
}

/**
 * @param {Record<string, WorkflowJob>} jobs
 * @returns {string}
 */
function workflowYaml (jobs) {
  const lines = ['name: test', 'on: push', 'jobs:']

  for (const [jobId, jobValue] of Object.entries(jobs)) {
    const job = Array.isArray(jobValue) ? { steps: jobValue } : jobValue
    lines.push(`  ${jobId}:`, '    runs-on: ubuntu-latest')

    if ('matrix' in job && job.matrix) {
      lines.push('    strategy:', '      matrix:')
      for (const [name, values] of Object.entries(job.matrix)) {
        lines.push(`        ${name}:`)
        for (const value of values) lines.push(`          - ${value}`)
      }
    }

    if ('env' in job && job.env) {
      lines.push('    env:')
      for (const [name, value] of Object.entries(job.env)) lines.push(`      ${name}: ${value}`)
    }

    lines.push('    steps:', ...stepLines(job.steps, ' '.repeat(6)))
  }

  return `${lines.join('\n')}\n`
}

/**
 * @param {JobSteps|string} action Composite steps, or raw YAML for a non-composite action.
 * @returns {string}
 */
function actionYaml (action) {
  if (typeof action === 'string') return action

  const lines = ['name: fixture', 'runs:', '  using: composite', '  steps:', ...stepLines(action, ' '.repeat(4))]

  return `${lines.join('\n')}\n`
}

/**
 * A single job whose glob narrows per matrix leg through the environment.
 *
 * @param {string[]} spec
 * @returns {Record<string, Record<string, WorkflowJob>>}
 */
function matrixWorkflow (spec) {
  return {
    'test.yml': {
      plugins: {
        matrix: { spec },
        env: { SPEC: MATRIX_SPEC },
        steps: ['npm run test:plugins:ci'],
      },
    },
  }
}

/**
 * @param {Partial<Fixture>} overrides
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runVerifier (overrides = {}) {
  const { scripts, workflows, files, actions } = { ...PASSING, ...overrides }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-verify-exercised-'))

  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts }))

    for (const [name, jobs] of Object.entries(workflows)) {
      const file = path.join(root, '.github', 'workflows', name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, typeof jobs === 'string' ? jobs : workflowYaml(jobs))
    }

    for (const [directory, action] of Object.entries(actions)) {
      const file = path.join(root, directory, 'action.yml')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, actionYaml(action))
    }

    for (const file of files) {
      const full = path.join(root, file)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, '')
    }

    const { status, stdout, stderr } = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' })
    return { status, stdout, stderr }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe('verify-exercised-tests', () => {
  it('verifies its own repository when no root is given', () => {
    const { status, stdout } = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })

    assert.strictEqual(status, 0)
    assert.match(stdout, /All CI workflows reference valid scripts, and plugin setup looks consistent\./)
  })

  it('accepts a checkout where every test file is exercised', () => {
    const { status, stdout } = runVerifier()

    assert.strictEqual(status, 0)
    assert.match(stdout, /All test files are covered by at least one package\.json script glob\./)
    assert.match(stdout, /^Test files: 1$/m)
  })

  it('reports a test file no script glob selects', () => {
    const { status, stderr } = runVerifier({
      files: ['packages/alpha/test/one.spec.js', 'orphan/lonely.spec.js'],
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /Test files not covered by any package\.json script glob\./)
    assert.match(stderr, /^- orphan\/lonely\.spec\.js$/m)
  })

  it('reports every test-file extension the repository allows', () => {
    const extensions = ['spec.js', 'spec.mjs', 'spec.cjs', 'test.js', 'test.mjs', 'test.cjs']
    const { status, stderr } = runVerifier({
      files: extensions.map(extension => `orphan/lonely.${extension}`),
    })

    assert.strictEqual(status, 1)
    for (const extension of extensions) {
      assert.match(stderr, new RegExp(String.raw`^- orphan/lonely\.${extension.replace('.', String.raw`\.`)}$`, 'm'))
    }
  })

  it('reports an unquoted globstar that POSIX sh would collapse', () => {
    const { status, stderr } = runVerifier({
      scripts: { 'test:unit:ci': 'mocha packages/**/test/**/*.spec.js' },
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /Unquoted `\*\*` globs detected in package\.json scripts/)
    assert.match(stderr, /script "test:unit:ci" contains an unquoted "\*\*"/)
  })

  it('reports a :ci script no workflow invokes', () => {
    const { status, stderr } = runVerifier({
      scripts: {
        ...PASSING.scripts,
        'test:extra:ci': 'mocha "packages/**/test/**/*.spec.js"',
      },
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /script "test:extra:ci" is not invoked by any GitHub Actions workflow/)
  })

  it('reports a workflow invoking a script that does not exist', () => {
    const { status, stderr } = runVerifier({
      workflows: { 'test.yml': { unit: ['npm run test:unit:ci', 'npm run test:missing'] } },
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /invokes missing script "test:missing"/)
  })

  it('reports a CI step whose script selects no test file', () => {
    const { status, stderr } = runVerifier({
      scripts: {
        ...PASSING.scripts,
        'test:empty:ci': 'mocha "nowhere/**/*.spec.js"',
      },
      workflows: { 'test.yml': { unit: ['npm run test:unit:ci', 'npm run test:empty:ci'] } },
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /"test:empty:ci" would match 0 test files/)
  })

  it('reports a test file that a script glob covers but no CI job reaches', () => {
    const { status, stderr } = runVerifier({
      scripts: {
        'test:unit:ci': 'mocha "packages/alpha/test/**/*.spec.js"',
        'test:beta': 'mocha "packages/beta/test/**/*.spec.js"',
      },
      files: ['packages/alpha/test/one.spec.js', 'packages/beta/test/two.spec.js'],
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /No CI workflow invocation expands a glob to exercise packages\/beta\/test\/two\.spec\.js/)
  })

  it('reports PLUGINS naming a plugin package that does not exist', () => {
    const { status, stderr } = runVerifier({
      scripts: {
        ...PASSING.scripts,
        'test:plugins:ci': `mocha "packages/datadog-plugin-@(${PLUGINS_VAR})/test/**/*.spec.js"`,
      },
      workflows: {
        'test.yml': {
          unit: ['npm run test:unit:ci', { run: 'npm run test:plugins:ci', env: { PLUGINS: 'nope' } }],
        },
      },
      files: ['packages/datadog-plugin-http/test/index.spec.js'],
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /PLUGINS includes "nope" but packages\/datadog-plugin-nope does not exist/)
  })

  it('accepts PLUGINS naming a plugin package that exists', () => {
    const { status } = runVerifier({
      scripts: {
        'test:plugins:ci': `mocha "packages/datadog-plugin-@(${PLUGINS_VAR})/test/**/*.spec.js"`,
      },
      workflows: {
        'test.yml': {
          plugins: [{ run: 'npm run test:plugins:ci', env: { PLUGINS: 'http' } }],
        },
      },
      files: ['packages/datadog-plugin-http/test/index.spec.js'],
    })

    assert.strictEqual(status, 0)
  })

  it('reports a job that generates coverage without uploading it', () => {
    const { status, stderr } = runVerifier({
      scripts: {
        ...PASSING.scripts,
        'test:cov:ci': 'node scripts/c8-ci.js test:unit:ci',
      },
      workflows: { 'test.yml': { unit: ['npm run test:cov:ci'] } },
    })

    assert.strictEqual(status, 1)
    assert.match(stderr, /generates coverage but does not upload it/)
  })

  describe('coverage upload ordering', () => {
    const scripts = { ...PASSING.scripts, 'test:cov:ci': 'node scripts/c8-ci.js test:unit:ci' }
    const upload = { uses: './.github/actions/coverage' }

    it('accepts a job that uploads after generating coverage', () => {
      const { status } = runVerifier({
        scripts,
        workflows: { 'test.yml': { unit: ['npm run test:cov:ci', upload] } },
      })

      assert.strictEqual(status, 0)
    })

    it('reports a job that generates coverage after its last upload', () => {
      const { status, stderr } = runVerifier({
        scripts,
        workflows: { 'test.yml': { unit: [upload, 'npm run test:cov:ci'] } },
      })

      assert.strictEqual(status, 1)
      assert.match(stderr, /test\.yml#unit: generates coverage after its last coverage upload/)
    })

    it('accepts a later upload that still covers an earlier suite', () => {
      const { status } = runVerifier({
        scripts,
        workflows: { 'test.yml': { unit: [upload, 'npm run test:cov:ci', upload] } },
      })

      assert.strictEqual(status, 0)
    })

    it('reports a suite repeated after the upload that already covered it', () => {
      const { status, stderr } = runVerifier({
        scripts,
        workflows: { 'test.yml': { unit: ['npm run test:cov:ci', upload, 'npm run test:cov:ci'] } },
      })

      assert.strictEqual(status, 1)
      assert.match(stderr, /generates coverage after its last coverage upload/)
    })

    it('reports the ordering inside a composite action', () => {
      const { status, stderr } = runVerifier({
        scripts,
        actions: { '.github/actions/suite': [upload, { run: 'npm run test:cov:ci' }] },
        workflows: { 'test.yml': { unit: [{ uses: './.github/actions/suite' }] } },
      })

      assert.strictEqual(status, 1)
      assert.match(stderr, /generates coverage after its last coverage upload/)
    })

    it('accepts a composite action that uploads after its suite', () => {
      const { status } = runVerifier({
        scripts,
        actions: { '.github/actions/suite': [{ run: 'npm run test:cov:ci' }, upload] },
        workflows: { 'test.yml': { unit: [{ uses: './.github/actions/suite' }] } },
      })

      assert.strictEqual(status, 0)
    })

    it('walks past steps that carry neither a command nor an action', () => {
      const { status } = runVerifier({
        workflows: {
          'test.yml': [
            'name: test',
            'on: push',
            'env:',
            '  DD_ENV: ci',
            '  DD_TELEMETRY: false',
            'jobs:',
            '  unit:',
            '    runs-on: ubuntu-latest',
            '    env:',
            '      DD_TRACE_DEBUG: true',
            '    steps:',
            '      -',
            '      - name: no command here',
            '      - uses: nick-fields/retry@v3',
            '      - run: npm run test:unit:ci',
          ].join('\n') + '\n',
        },
      })

      assert.strictEqual(status, 0)
    })

    it('reports a local action whose steps it cannot read', () => {
      const { status, stderr } = runVerifier({
        actions: { '.github/actions/bundled': 'name: fixture\nruns:\n  using: node20\n  main: index.js\n' },
        workflows: { 'test.yml': { unit: ['npm run test:unit:ci', { uses: './.github/actions/bundled' }] } },
      })

      assert.strictEqual(status, 1)
      assert.match(stderr, /cannot inspect local action "\.\/\.github\/actions\/bundled", which is not a composite action/)
    })

    it('reports an action file it cannot read as a composite action', () => {
      const { status, stderr } = runVerifier({
        actions: { '.github/actions/empty': '' },
        workflows: { 'test.yml': { unit: ['npm run test:unit:ci', { uses: './.github/actions/empty' }] } },
      })

      assert.strictEqual(status, 1)
      assert.match(stderr, /cannot inspect local action "\.\/\.github\/actions\/empty"/)
    })

    it('accepts a composite action that declares no steps', () => {
      const { status } = runVerifier({
        actions: { '.github/actions/noop': 'name: fixture\nruns:\n  using: composite\n' },
        workflows: { 'test.yml': { unit: ['npm run test:unit:ci', { uses: './.github/actions/noop' }] } },
      })

      assert.strictEqual(status, 0)
    })
  })

  describe('matrix legs', () => {
    // `SPEC` reaches the glob only through the environment, so an unresolved matrix expression
    // widens the pattern to `*` and hides every spec no leg actually selects.
    const scripts = {
      'test:plugins:ci': `mocha "packages/datadog-plugin-alpha/test/**/${SPEC_VAR}*.spec.js"`,
    }
    const files = [
      'packages/datadog-plugin-alpha/test/one.spec.js',
      'packages/datadog-plugin-alpha/test/two.spec.js',
    ]

    it('reports a spec that no matrix leg selects', () => {
      const { status, stderr } = runVerifier({ scripts, files, workflows: matrixWorkflow(['one']) })

      assert.strictEqual(status, 1)
      assert.match(stderr, /exercise packages\/datadog-plugin-alpha\/test\/two\.spec\.js/)
    })

    it('accepts specs that the matrix legs cover between them', () => {
      const { status } = runVerifier({ scripts, files, workflows: matrixWorkflow(['one', 'two']) })

      assert.strictEqual(status, 0)
    })
  })

  it('warns about a dd-trace test category test:trace:core excludes', () => {
    const { status, stdout } = runVerifier({
      scripts: {
        ...PASSING.scripts,
        'test:trace:core': 'mocha "packages/dd-trace/test/{alpha}/**/*.spec.js"',
      },
      files: [
        'packages/dd-trace/test/alpha/one.spec.js',
        'packages/dd-trace/test/beta/two.spec.js',
      ],
    })

    assert.strictEqual(status, 1)
    assert.match(stdout, /test:trace:core excludes "beta"/)
    assert.match(stdout, /^ {2}- packages\/dd-trace\/test\/beta\/two\.spec\.js$/m)
  })

  it('follows a script into the nested script it invokes', () => {
    const { status } = runVerifier({
      scripts: {
        'test:unit:ci': 'npm run test:unit:inner',
        'test:unit:inner': 'mocha "packages/**/test/**/*.spec.js"',
      },
    })

    assert.strictEqual(status, 0)
  })

  it('ignores test files under node_modules', () => {
    const { status } = runVerifier({
      files: [
        'packages/alpha/test/one.spec.js',
        'packages/alpha/test/node_modules/fixture/ignored.spec.js',
      ],
    })

    assert.strictEqual(status, 0)
  })
})
