import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

import { describe, it } from 'mocha'
import YAML from 'yaml'

const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/pr-title.yml', import.meta.url), 'utf8'))
const job = workflow.jobs['conventional-commit']
const steps = new Map()
for (const step of job.steps) steps.set(step.name, step)

const validation = steps.get('Validate PR title')
const labelSync = steps.get('Sync labels with PR title')
const validateTitle = vm.runInNewContext(
  `(async function validateTitle (context, core, process) {\n${validation.with.script}\n})`
)
const syncLabels = vm.runInNewContext(
  `(async function syncLabels (context, github, process) {\n${labelSync.with.script}\n})`
)
const validate = async (title) => {
  const failures = []
  const context = { payload: { pull_request: { title } } }
  const core = {
    info: Function.prototype,
    setFailed: message => failures.push(message),
  }
  const process = { env: { PR_TITLE_PATTERN: job.env.PR_TITLE_PATTERN } }

  await validateTitle(context, core, process)

  return failures
}

describe('PR title workflow', () => {
  it('rejects production types for non-production scopes', async () => {
    const expectedTypeByScope = new Map([
      ['agents', 'docs'],
      ['bench', 'bench'],
      ['benchmark', 'bench'],
      ['benchmarks', 'bench'],
      ['build', 'build'],
      ['chore', 'chore'],
      ['codeowners', 'chore'],
      ['dependabot', 'ci'],
      ['deps-dev', 'chore'],
      ['docs', 'docs'],
      ['documentation', 'docs'],
      ['eslint', 'chore'],
      ['github', 'ci'],
      ['gitlab', 'ci'],
      ['integration-test', 'test'],
      ['integration-tests', 'test'],
      ['lint', 'chore'],
      ['release', 'ci'],
      ['scripts', 'chore'],
      ['style', 'style'],
      ['test', 'test'],
      ['tests', 'test'],
      ['testing', 'test'],
      ['workflows', 'ci'],
    ])

    await Promise.all(['feat', 'fix', 'perf'].flatMap(type => [...expectedTypeByScope].map(
      async ([scope, expectedType]) => {
        const failures = await validate(`${type}(${scope}): change`)
        assert.deepStrictEqual(failures, [
          `PR title type "${type}" is not valid when every scope is non-production ` +
          `("${scope}"). Use "${expectedType}" instead.`,
        ])
      }
    )))
  })

  it('rejects a scope list when every scope is non-production', async () => {
    const failures = await validate('fix(docs, tests): change')
    assert.deepStrictEqual(failures, [
      'PR title type "fix" is not valid when every scope is non-production ' +
      '("docs, tests"). Use "docs" or "test" instead.',
    ])
  })

  it('rejects empty entries in a scope list', async () => {
    const titles = [
      'fix(docs,): change',
      'fix(docs, ): change',
    ]

    await Promise.all(titles.map(async (title) => {
      const failures = await validate(title)
      assert.deepStrictEqual(failures, ['PR title scope list contains an empty scope.'], title)
    }))
  })

  it('allows production and product scopes', async () => {
    const titles = [
      'feat(http): change',
      'fix(ci-visibility): change',
      'fix(test-optimization): change',
      'fix(http, tests): change',
      'feat(ci): change',
      'perf(http): change',
      'perf(agent): change',
      'feat(coverage): change',
      'fix(integration): change',
      'fix: change',
      'docs(test): change',
      'test(http): change',
    ]

    await Promise.all(titles.map(async (title) => {
      const failures = await validate(title)
      assert.deepStrictEqual(failures, [], title)
    }))
  })

  it('does not call the GitHub API during validation', () => {
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

  it('runs title-dependent steps only for events that can require reconciliation', () => {
    const expectedCondition = "steps.rename.outputs.renamed != 'true' && " +
      "(github.event.action == 'opened' || " +
      "github.event.action == 'reopened' || " +
      "(github.event.action == 'edited' && github.event.changes.title != null))"

    for (const step of [validation, labelSync]) {
      assert.strictEqual(step.if.replaceAll(/\s+/g, ' '), expectedCondition)
    }
  })
})
