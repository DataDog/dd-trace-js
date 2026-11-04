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
 * @typedef {{
 *   query: string,
 *   variables: Record<string, string | { pullRequestId: string, labelIds: string[] }>
 * }} LabelRequest
 */

/**
 * @param {{
 *   title: string,
 *   labels?: Array<{ name: string, node_id: string }>,
 *   repositoryLabels?: Record<string, string>,
 *   requests?: LabelRequest[]
 * }} options
 */
const runLabelSync = async ({ title, labels = [], repositoryLabels = {}, requests = [] }) => {
  const payload = { action: 'opened', pull_request: { node_id: 'PR_1', title, labels } }
  const context = { repo: { owner: 'DataDog', repo: 'dd-trace-js' }, payload }
  const github = {
    /**
     * @param {string} query
     * @param {LabelRequest['variables']} variables
     */
    graphql: (query, variables) => {
      requests.push({ query, variables: structuredClone(variables) })
      if (!query.startsWith('query')) return {}

      const id = repositoryLabels[variables.name]
      return { repository: { label: id ? { id } : null } }
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

  const semverCases = [
    ['feat(http, tests): change', 'semver-minor'],
    ['fix(http, unknown): change', 'semver-patch'],
    ['docs: change', 'semver-patch'],
    ['perf: change', 'semver-patch'],
    ['style: change', 'semver-patch'],
    ['refactor: change', 'semver-patch'],
    ['test: change', 'semver-patch'],
    ['bench: change', 'semver-patch'],
    ['build: change', 'semver-patch'],
    ['ci: change', 'semver-patch'],
    ['chore(deps): change', 'semver-patch'],
    ['fix!: change', 'semver-major'],
    ['feat(http)!: change', 'semver-major'],
    ['revert: feat(http)!: change', 'semver-patch'],
    ['revert!: feat(http): change', 'semver-major'],
  ]

  for (const [title, semver] of semverCases) {
    it(`syncs only ${semver} for "${title}"`, async () => {
      const requests = await runLabelSync({
        title,
        repositoryLabels: { [semver]: 'L_semver', feat: 'L_feat', http: 'L_http', tests: 'L_tests' },
      })

      assert.strictEqual(requests.length, 2)
      assert.deepStrictEqual(requests[0].variables, { owner: 'DataDog', repo: 'dd-trace-js', name: semver })
      assert.match(requests[0].query, /repository\(owner: \$owner, name: \$repo\)/)
      assert.match(requests[0].query, /label\(name: \$name\)\s*\{ id \}/)
      assert.deepStrictEqual(requests[1].variables, {
        input: { pullRequestId: 'PR_1', labelIds: ['L_semver'] },
      })
      assert.match(requests[1].query, /updatePullRequest/)
    })
  }

  it('replaces stale semver labels and preserves every other label', async () => {
    const requests = await runLabelSync({
      title: 'feat(db): change',
      labels: [
        { name: 'fix', node_id: 'L_fix' },
        { name: 'http', node_id: 'L_http' },
        { name: 'semver-patch', node_id: 'L_semver-patch' },
        { name: 'semver-major', node_id: 'L_semver-major' },
        { name: 'dependencies', node_id: 'L_dependencies' },
        { name: 'semver-custom', node_id: 'L_semver-custom' },
      ],
      repositoryLabels: { feat: 'L_feat', db: 'L_db', 'semver-minor': 'L_semver-minor' },
    })

    assert.strictEqual(requests.length, 2)
    assert.deepStrictEqual(requests[1].variables, {
      input: {
        pullRequestId: 'PR_1',
        labelIds: ['L_fix', 'L_http', 'L_dependencies', 'L_semver-custom', 'L_semver-minor'],
      },
    })
  })

  it('skips GitHub API calls when only the expected semver label is present', async () => {
    await Promise.all(semverCases.map(async ([title, semver]) => {
      const requests = await runLabelSync({
        title,
        labels: [
          { name: semver, node_id: 'L_semver' },
          { name: 'unrelated', node_id: 'L_unrelated' },
        ],
      })

      assert.deepStrictEqual(requests, [], title)
    }))
  })

  it('removes conflicting semver labels without looking up an existing label', async () => {
    await Promise.all(semverCases.map(async ([title, semver]) => {
      const requests = await runLabelSync({
        title,
        labels: [
          { name: 'semver-major', node_id: 'L_semver-major' },
          { name: 'semver-minor', node_id: 'L_semver-minor' },
          { name: 'semver-patch', node_id: 'L_semver-patch' },
          { name: 'unrelated', node_id: 'L_unrelated' },
        ],
      })

      assert.strictEqual(requests.length, 1, title)
      assert.match(requests[0].query, /updatePullRequest/)
      assert.deepStrictEqual(requests[0].variables, {
        input: { pullRequestId: 'PR_1', labelIds: ['L_unrelated', `L_${semver}`] },
      })
    }))
  })

  it('skips label synchronization for an invalid title', async () => {
    assert.deepStrictEqual(await runLabelSync({ title: 'invalid title' }), [])
  })

  it('fails before mutation when the required semver label does not exist', async () => {
    const requests = []

    await assert.rejects(runLabelSync({ title: 'fix: change', requests }), {
      name: 'Error',
      message: 'Missing repository label: semver-patch',
    })

    assert.strictEqual(requests.length, 1)
    assert.match(requests[0].query, /^query\(/)
  })

  it('inspects files for every event unless the title was auto-renamed', () => {
    const inspectionCondition = "steps.rename.outputs.renamed != 'true'"

    for (const step of [checkout, fetchHead, validation]) {
      assert.strictEqual(step.if.replaceAll(/\s+/g, ' '), inspectionCondition)
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
