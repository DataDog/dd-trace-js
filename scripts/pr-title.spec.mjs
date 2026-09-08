import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

import { describe, it } from 'mocha'
import YAML from 'yaml'

const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/pr-title.yml', import.meta.url), 'utf8'))
const job = workflow.jobs['conventional-commit']
const steps = new Map()
for (const step of job.steps) steps.set(step.name, step)

const checkout = steps.get('Checkout base revision')
const fetchHead = steps.get('Fetch pull request head')
const validation = steps.get('Validate PR title and release-note context')
const labelSync = steps.get('Sync labels with PR title')
const validateTitle = vm.runInNewContext(
  `(async function validateTitle (context, core, process, require) {\n${validation.with.script}\n})`
)
const syncLabels = vm.runInNewContext(
  `(async function syncLabels (context, github, process) {\n${labelSync.with.script}\n})`
)
const require = createRequire(import.meta.url)
const { isInternalOnly } = require('./release/changelog')
const validate = async (title, files = []) => {
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
  const process = { env: { PR_TITLE_PATTERN: job.env.PR_TITLE_PATTERN } }
  const loadModule = (id) => {
    if (id === 'node:child_process') {
      return {
        execFileSync: (command, args, options) => {
          commands.push({ command, args: [...args], options: { ...options } })
          return `${files.join('\0')}${files.length ? '\0' : ''}`
        },
      }
    }
    if (id === './scripts/release/changelog') return { isInternalOnly }
    assert.fail(`Unexpected module: ${id}`)
  }

  await validateTitle(context, core, process, loadModule)

  return { commands, failures }
}

describe('PR title workflow', () => {
  it('rejects public release-note types for internal-only changes', async () => {
    await Promise.all(['feat', 'fix', 'perf', 'docs'].map(async (type) => {
      const { failures } = await validate(`${type}(http): change`, [
        'scripts/pr-title.spec.mjs',
        'packages/dd-trace/test/index.spec.js',
      ])
      assert.deepStrictEqual(failures, [
        `PR title type "${type}" is public, but every changed file is internal. ` +
        'Use test, bench, ci, or chore.',
      ])
    }))
  })

  it('allows public release-note types when any changed file is public', async () => {
    const titles = [
      'feat(http): change',
      'fix(http): change',
      'perf(http): change',
      'docs(test): change',
    ]

    await Promise.all(titles.map(async (title) => {
      const { failures } = await validate(title, [
        'scripts/pr-title.spec.mjs',
        'packages/dd-trace/src/index.js',
      ])
      assert.deepStrictEqual(failures, [], title)
    }))
  })

  it('skips file inspection for internal title types', async () => {
    await Promise.all(['test', 'bench', 'ci', 'chore'].map(async (type) => {
      const { commands, failures } = await validate(`${type}(http): change`)
      assert.deepStrictEqual(failures, [])
      assert.deepStrictEqual(commands, [])
    }))
  })

  it('derives changed paths from the fetched PR ref without a GitHub API call', async () => {
    const { commands } = await validate('fix(http): change', ['packages/dd-trace/src/index.js'])

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
    assert.doesNotMatch(validation.with.script, /\bgithub\./)
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
    const process = { env: { PR_TITLE_PATTERN: job.env.PR_TITLE_PATTERN } }

    await syncLabels(context, github, process)

    assert.deepStrictEqual([...request.labels], ['fix', 'http', 'tests', 'semver-patch'])
  })

  it('inspects files whenever the title or changed files can differ', () => {
    const inspectionCondition = "steps.rename.outputs.renamed != 'true' && " +
      "(github.event.action != 'edited' || github.event.changes.title != null)"
    const titleCondition = "steps.rename.outputs.renamed != 'true' && " +
      "(github.event.action == 'opened' || " +
      "github.event.action == 'reopened' || " +
      "(github.event.action == 'edited' && github.event.changes.title != null))"

    for (const step of [checkout, fetchHead, validation]) {
      assert.strictEqual(step.if.replaceAll(/\s+/g, ' '), inspectionCondition)
    }
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
