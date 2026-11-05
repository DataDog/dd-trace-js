import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'

import { describe, it } from 'mocha'
import YAML from 'yaml'

const require = createRequire(import.meta.url)
const { renamePullRequest } = require('./pr-title/rename')
const { graphqlWithGh, syncLabels } = require('./pr-title/sync-labels')
const { validateTitle } = require('./pr-title/validate')

const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/pr-title.yml', import.meta.url), 'utf8'))
const job = workflow.jobs['conventional-commit']
const steps = new Map()
for (const step of job.steps) steps.set(step.name, step)

const rename = steps.get('Auto-rename GitHub revert title to Conventional Commit')
const checkout = steps.get('Checkout base revision')
const fetchHead = steps.get('Fetch pull request head')
const validation = steps.get('Validate PR title and release-note context')
const labelSync = steps.get('Sync labels with PR title')
const env = {
  PR_TITLE_PATTERN: job.env.PR_TITLE_PATTERN,
  SEMVER_MAJOR_LABEL_ID: job.env.SEMVER_MAJOR_LABEL_ID,
  SEMVER_MINOR_LABEL_ID: job.env.SEMVER_MINOR_LABEL_ID,
  SEMVER_PATCH_LABEL_ID: job.env.SEMVER_PATCH_LABEL_ID,
}
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
  const runGit = (command, args, options) => {
    commands.push({ command, args: [...args], options: { ...options } })
    return `${files.join('\0')}${files.length ? '\0' : ''}`
  }

  await validateTitle({ context, core, env, runGit })

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
  })

  it('auto-renames GitHub revert titles', async () => {
    const titles = []
    const outputs = []
    const context = {
      payload: {
        pull_request: { title: 'Revert "fix(http): change"' },
      },
    }

    await renamePullRequest({
      context,
      updateTitle: title => titles.push(title),
      setOutput: (name, value) => outputs.push({ name, value }),
    })

    assert.deepStrictEqual(titles, ['revert: fix(http): change'])
    assert.deepStrictEqual(outputs, [{ name: 'renamed', value: 'true' }])
  })

  it('syncs only the semver label in one GraphQL request', async () => {
    const requests = []
    const context = {
      repo: { owner: 'DataDog', repo: 'dd-trace-js' },
      payload: {
        action: 'opened',
        pull_request: {
          number: 1,
          node_id: 'pull-request-id',
          title: 'fix(http, tests): change',
          labels: [
            { name: 'fix', node_id: 'fix-id' },
            { name: 'http', node_id: 'http-id' },
            { name: 'semver-minor', node_id: job.env.SEMVER_MINOR_LABEL_ID },
          ],
        },
      },
    }
    const github = {
      graphql: (query, variables) => requests.push({ query, variables }),
    }

    await syncLabels({ context, github, env })

    assert.strictEqual(requests.length, 1)
    assert.match(requests[0].query, /addLabelsToLabelable/)
    assert.match(requests[0].query, /removeLabelsFromLabelable/)
    assert.deepStrictEqual({
      ...requests[0].variables,
      addLabelIds: [...requests[0].variables.addLabelIds],
      removeLabelIds: [...requests[0].variables.removeLabelIds],
    }, {
      pullRequestId: 'pull-request-id',
      addLabelIds: [job.env.SEMVER_PATCH_LABEL_ID],
      removeLabelIds: [job.env.SEMVER_MAJOR_LABEL_ID, job.env.SEMVER_MINOR_LABEL_ID],
    })
  })

  it('sends the label mutations through one gh GraphQL request', () => {
    const commands = []
    const runCommand = (command, args, options) => {
      commands.push({ command, args, options })
      return JSON.stringify({ data: {} })
    }

    graphqlWithGh('mutation Test { test }', {
      pullRequestId: 'pull-request-id',
      addLabelIds: ['add-id'],
      removeLabelIds: ['remove-id-1', 'remove-id-2'],
    }, runCommand)

    assert.strictEqual(commands.length, 1)
    assert.deepStrictEqual(commands[0], {
      command: 'gh',
      args: [
        'api',
        'graphql',
        '--method',
        'POST',
        '--raw-field',
        'query=mutation Test { test }',
        '--field',
        'pullRequestId=pull-request-id',
        '--field',
        'addLabelIds[]=add-id',
        '--field',
        'removeLabelIds[]=remove-id-1',
        '--field',
        'removeLabelIds[]=remove-id-2',
      ],
      options: { encoding: 'utf8' },
    })
  })

  it('syncs same-semver edits when the event labels are missing or incorrect', async () => {
    const labelSets = [
      [],
      [{ name: 'semver-minor' }],
      [{ name: 'semver-patch' }, { name: 'semver-minor' }],
    ]

    await Promise.all(labelSets.map(async (labels) => {
      const requests = []
      const context = {
        payload: {
          action: 'edited',
          changes: { title: { from: 'fix(http): before' } },
          pull_request: {
            node_id: 'pull-request-id',
            title: 'fix(express): after',
            labels,
          },
        },
      }
      const github = {
        graphql: (query, variables) => requests.push({ query, variables }),
      }

      await syncLabels({ context, github, env })

      assert.strictEqual(requests.length, 1)
    }))
  })

  it('does not sync same-semver edits when the event already has the valid semver label', async () => {
    const context = {
      payload: {
        action: 'edited',
        changes: { title: { from: 'fix(http): before' } },
        pull_request: {
          node_id: 'pull-request-id',
          title: 'fix(express): after',
          labels: [
            { name: 'http' },
            { name: 'semver-patch' },
          ],
        },
      },
    }
    const github = { graphql: assert.fail }

    await syncLabels({ context, github, env })
  })

  it('inspects files for every event unless the title was auto-renamed', () => {
    const inspectionCondition = "steps.rename.outputs.renamed != 'true'"

    for (const step of [fetchHead, validation]) {
      assert.strictEqual(step.if.replaceAll(/\s+/g, ' '), inspectionCondition)
    }
  })

  it('runs commands without inline workflow JavaScript', () => {
    assert.strictEqual(rename.run, 'node scripts/pr-title/rename.js')
    assert.strictEqual(validation.run, 'node scripts/pr-title/validate.js')
    assert.strictEqual(labelSync.run, 'node scripts/pr-title/sync-labels.js')
    for (const step of job.steps) {
      assert.doesNotMatch(step.uses || '', /actions\/github-script/)
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
    assert.strictEqual(job.steps[0], checkout)
    assert.strictEqual(checkout.if, undefined)
    assert.strictEqual(checkout.with.ref, '$' + '{{ github.sha }}')
    assert.strictEqual(checkout.with['fetch-depth'], 0)
    assert.strictEqual(checkout.with['persist-credentials'], false)
    assert.match(fetchHead.run, /refs\/pull\/\$\{PR_NUMBER\}\/head/)
    assert.match(fetchHead.run, /refs\/remotes\/pull-request\/head/)
  })
})
