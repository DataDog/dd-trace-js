import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'

import { after, before, describe, it } from 'mocha'
import sinon from 'sinon'
import YAML from 'yaml'

const require = createRequire(import.meta.url)
const { renameRevert, syncLabels, validateTitle } = require('./pr-title')

const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/pr-title.yml', import.meta.url), 'utf8'))
const job = workflow.jobs['conventional-commit']
const steps = new Map()
for (const step of job.steps) steps.set(step.name, step)

const checkout = steps.get('Checkout base revision')
const rename = steps.get('Auto-rename GitHub revert title to Conventional Commit')
const fetchHead = steps.get('Fetch pull request head')
const validation = steps.get('Validate PR title and release-note context')
const labelSync = steps.get('Sync labels with PR title')

const validate = (title, files = []) => {
  const failures = []
  const commands = []
  const context = {
    payload: {
      pull_request: {
        title,
        base: { sha: 'base-sha' },
      },
    },
  }
  const core = {
    info: Function.prototype,
    setFailed: message => failures.push(message),
  }
  sinon.stub(childProcess, 'execFileSync').callsFake((command, args, options) => {
    commands.push({ command, args: [...args], options: { ...options } })
    return `${files.join('\0')}${files.length ? '\0' : ''}`
  })

  try {
    validateTitle({ context, core })
  } finally {
    childProcess.execFileSync.restore()
  }

  return { commands, failures }
}

describe('PR title workflow', () => {
  let originalPattern

  before(() => {
    originalPattern = process.env.PR_TITLE_PATTERN
    process.env.PR_TITLE_PATTERN = job.env.PR_TITLE_PATTERN
  })

  after(() => {
    if (originalPattern === undefined) {
      delete process.env.PR_TITLE_PATTERN
    } else {
      process.env.PR_TITLE_PATTERN = originalPattern
    }
  })

  it('rejects public release-note types for internal-only changes', () => {
    for (const type of ['feat', 'fix', 'perf', 'docs']) {
      const { failures } = validate(`${type}(http): change`, [
        'scripts/pr-title.spec.mjs',
        'packages/dd-trace/test/index.spec.js',
      ])
      assert.deepStrictEqual(failures, [
        `PR title type "${type}" is public, but every changed file is internal. ` +
        'Use test, bench, ci, or chore.',
      ])
    }
  })

  it('allows public release-note types when any changed file is public', () => {
    const titles = [
      'feat(http): change',
      'fix(http): change',
      'perf(http): change',
      'docs(test): change',
    ]

    for (const title of titles) {
      const { failures } = validate(title, [
        'scripts/pr-title.spec.mjs',
        'packages/dd-trace/src/index.js',
      ])
      assert.deepStrictEqual(failures, [], title)
    }
  })

  it('skips file inspection for internal title types', () => {
    for (const type of ['test', 'bench', 'ci', 'chore']) {
      const { commands, failures } = validate(`${type}(http): change`)
      assert.deepStrictEqual(failures, [])
      assert.deepStrictEqual(commands, [])
    }
  })

  it('derives changed paths from the fetched PR ref without a GitHub API call', () => {
    const { commands } = validate('fix(http): change', ['packages/dd-trace/src/index.js'])

    assert.deepStrictEqual(commands, [{
      command: 'git',
      args: [
        'diff',
        '--name-only',
        '--no-renames',
        '-z',
        'base-sha...refs/remotes/pull-request/head',
      ],
      options: { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    }])
    assert.doesNotMatch(validation.with.script, /\bgithub\b/)
    assert.doesNotMatch(validateTitle.toString(), /\bgithub\./)
  })

  it('syncs each label in a scope list', async () => {
    let request
    const context = {
      repo: { owner: 'DataDog', repo: 'dd-trace-js' },
      payload: {
        action: 'opened',
        pull_request: {
          number: 1,
          title: 'fix(http, tests): change',
          labels: [],
        },
      },
    }
    const github = {
      paginate: {
        iterator: () => [{ data: ['fix', 'http', 'tests'].map(name => ({ name })) }],
      },
      rest: {
        issues: {
          listLabelsForRepo: Function.prototype,
          setLabels: value => { request = value },
        },
      },
    }
    await syncLabels({ context, github })

    assert.deepStrictEqual([...request.labels], ['fix', 'http', 'tests', 'semver-patch'])
  })

  it('inspects files for every event unless the title was auto-renamed', () => {
    const inspectionCondition = "steps.rename.outputs.renamed != 'true'"

    for (const step of [fetchHead, validation]) {
      assert.strictEqual(step.if.replaceAll(/\s+/g, ' '), inspectionCondition)
    }
  })

  it('renames GitHub revert titles', async () => {
    let request
    const outputs = {}
    const context = {
      repo: { owner: 'DataDog', repo: 'dd-trace-js' },
      payload: { pull_request: { number: 1, title: 'Revert "fix(http): change"' } },
    }
    const core = {
      notice: Function.prototype,
      setOutput: (name, value) => { outputs[name] = value },
    }
    const github = { rest: { pulls: { update: value => { request = value } } } }

    await renameRevert({ context, core, github })

    assert.deepStrictEqual(request, {
      owner: 'DataDog',
      repo: 'dd-trace-js',
      pull_number: 1,
      title: 'revert: fix(http): change',
    })
    assert.deepStrictEqual(outputs, { renamed: 'true' })
  })

  it('checks out the base before any step loads code from it', () => {
    assert.strictEqual(job.steps[0], checkout)
    assert.strictEqual(checkout.if, undefined)

    for (const step of [rename, validation, labelSync]) {
      assert.match(step.with.script, /^(?:return )?require\('\.\/scripts\/pr-title'\)\.\w+\(/)
    }
  })

  it('skips label synchronization for dependency bot pull requests', () => {
    const titleCondition = "steps.rename.outputs.renamed != 'true' && " +
      "github.event.pull_request.user.login != 'dependabot[bot]' && " +
      "github.event.pull_request.user.login != 'renovate[bot]' && " +
      "(github.event.action == 'opened' || " +
      "github.event.action == 'reopened' || " +
      "(github.event.action == 'edited' && github.event.changes.title != null))"

    assert.strictEqual(labelSync.if.replaceAll(/\s+/g, ' '), titleCondition)
  })

  it('checks out only the trusted base and fetches the PR head without checking it out', () => {
    assert.strictEqual(checkout.with.ref, '$' + '{{ github.sha }}')
    assert.strictEqual(checkout.with['fetch-depth'], 0)
    assert.strictEqual(checkout.with['persist-credentials'], false)
    assert.match(fetchHead.run, /refs\/pull\/\$\{PR_NUMBER\}\/head/)
    assert.match(fetchHead.run, /refs\/remotes\/pull-request\/head/)
  })
})
