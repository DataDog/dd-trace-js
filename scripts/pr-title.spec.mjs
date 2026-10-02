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
const rename = steps.get('Auto-rename GitHub revert title to Conventional Commit')
const validateTitle = vm.runInNewContext(
  `(async function validateTitle (context, core, process, require) {\n${validation.with.script}\n})`
)
const syncLabels = vm.runInNewContext(
  `(async function syncLabels (context, github, process) {\n${labelSync.with.script}\n})`
)
const renameTitle = vm.runInNewContext(
  `(async function renameTitle (context, core, github) {\n${rename.with.script}\n})`
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

/**
 * @param {{
 *   title: string,
 *   labels?: Array<{ name: string, node_id: string }>,
 *   action?: string,
 *   previousTitle?: string,
 *   repositoryLabels?: Record<string, string>
 * }} options
 */
const runLabelSync = async ({ title, labels = [], action = 'opened', previousTitle, repositoryLabels = {} }) => {
  const requests = []
  const payload = { action, pull_request: { node_id: 'PR_1', title, labels } }
  if (previousTitle !== undefined) payload.changes = { title: { from: previousTitle } }
  const context = { repo: { owner: 'DataDog', repo: 'dd-trace-js' }, payload }
  const github = {
    /**
     * @param {string} query
     * @param {Record<string, string | { pullRequestId: string, labelIds: string[] }>} variables
     */
    graphql: (query, variables) => {
      requests.push({ query, variables: structuredClone(variables) })
      if (!query.startsWith('query')) return {}

      const repository = {}
      for (const [key, name] of Object.entries(variables)) {
        if (key.startsWith('label') && query.includes(`${key}: label(name: $${key}) { id }`)) {
          repository[key] = Object.hasOwn(repositoryLabels, name) ? { id: repositoryLabels[name] } : null
        }
      }
      return { repository }
    },
  }
  const process = { env: { PR_TITLE_PATTERN: job.env.PR_TITLE_PATTERN } }

  await syncLabels(context, github, process)

  return requests
}

describe('PR title workflow', () => {
  it('renames GitHub revert titles without using the REST API', async () => {
    let request
    const context = { payload: { pull_request: { node_id: 'PR_1', title: 'Revert "fix(http): change"' } } }
    const core = { notice: Function.prototype, setOutput: Function.prototype }
    const github = {
      /**
       * @param {string} query
       * @param {{ input: { pullRequestId: string, title: string } }} variables
       */
      graphql: (query, variables) => {
        request = { query, variables }
        return {}
      },
    }

    await renameTitle(context, core, github)

    assert.match(request.query, /updatePullRequest/)
    assert.deepStrictEqual(structuredClone(request.variables), {
      input: { pullRequestId: 'PR_1', title: 'revert: fix(http): change' },
    })
  })

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
    const requests = await runLabelSync({
      title: 'fix(http, tests): change',
      repositoryLabels: {
        fix: 'L_fix',
        http: 'L_http',
        tests: 'L_tests',
        'semver-patch': 'L_semver-patch',
      },
    })

    assert.strictEqual(requests.length, 2)
    assert.deepStrictEqual(requests[0].variables, {
      owner: 'DataDog',
      repo: 'dd-trace-js',
      label0: 'fix',
      label1: 'http',
      label2: 'tests',
      label3: 'semver-patch',
    })
    assert.match(requests[0].query, /repository\(owner: \$owner, name: \$repo\)/)
    assert.deepStrictEqual(requests[1].variables, {
      input: { pullRequestId: 'PR_1', labelIds: ['L_fix', 'L_http', 'L_tests', 'L_semver-patch'] },
    })
    assert.match(requests[1].query, /updatePullRequest/)
  })

  it('skips GitHub API calls when the title labels are already present', async () => {
    const requests = await runLabelSync({
      title: 'fix(http): change',
      labels: [
        { name: 'fix', node_id: 'L_fix' },
        { name: 'http', node_id: 'L_http' },
        { name: 'semver-patch', node_id: 'L_semver-patch' },
      ],
    })

    assert.deepStrictEqual(requests, [])
  })

  it('replaces stale title labels and preserves unrelated labels', async () => {
    const requests = await runLabelSync({
      title: 'feat(db): change',
      action: 'edited',
      previousTitle: 'fix(http): change',
      labels: [
        { name: 'fix', node_id: 'L_fix' },
        { name: 'http', node_id: 'L_http' },
        { name: 'semver-patch', node_id: 'L_semver-patch' },
        { name: 'dependencies', node_id: 'L_dependencies' },
      ],
      repositoryLabels: { feat: 'L_feat', db: 'L_db', 'semver-minor': 'L_semver-minor' },
    })

    assert.strictEqual(requests.length, 2)
    assert.deepStrictEqual(requests[1].variables, {
      input: { pullRequestId: 'PR_1', labelIds: ['L_dependencies', 'L_feat', 'L_db', 'L_semver-minor'] },
    })
  })

  it('ignores scope labels that do not exist in the repository', async () => {
    const requests = await runLabelSync({
      title: 'fix(http, unknown): change',
      labels: [
        { name: 'fix', node_id: 'L_fix' },
        { name: 'http', node_id: 'L_http' },
        { name: 'semver-patch', node_id: 'L_semver-patch' },
      ],
    })

    assert.strictEqual(requests.length, 1)
    assert.strictEqual(requests[0].variables.label0, 'unknown')
  })

  it('does not mutate a dependency PR when its title labels do not exist', async () => {
    const requests = await runLabelSync({
      title: 'chore(deps): bump dependencies',
      labels: [
        { name: 'semver-patch', node_id: 'L_semver-patch' },
        { name: 'dependencies', node_id: 'L_dependencies' },
        { name: 'github_actions', node_id: 'L_github_actions' },
        { name: 'dependabot', node_id: 'L_dependabot' },
      ],
    })

    assert.strictEqual(requests.length, 1)
    assert.deepStrictEqual(requests[0].variables, {
      owner: 'DataDog',
      repo: 'dd-trace-js',
      label0: 'chore',
      label1: 'deps',
    })
  })

  it('fails when the required semver label does not exist', async () => {
    await assert.rejects(runLabelSync({ title: 'fix: change' }), /Missing repository label: semver-patch/)
  })

  it('inspects files for every event unless the title was auto-renamed', () => {
    const inspectionCondition = "steps.rename.outputs.renamed != 'true'"
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
