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
      ['ci', 'ci'],
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
          `PR title type "${type}" is not valid for non-production scope "${scope}". ` +
          `Use "${expectedType}" instead.`,
        ])
      }
    )))
  })

  it('rejects a non-production scope in a scope list', async () => {
    const failures = await validate('fix(http, tests): change')
    assert.strictEqual(failures.length, 1)
  })

  it('allows production and product scopes', async () => {
    const titles = [
      'feat(http): change',
      'fix(ci-visibility): change',
      'fix(test-optimization): change',
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

  it('syncs labels only for events that can require reconciliation', () => {
    assert.strictEqual(labelSync.if.replaceAll(/\s+/g, ' '),
      "steps.rename.outputs.renamed != 'true' && " +
      "(github.event.action == 'opened' || " +
      "github.event.action == 'reopened' || " +
      "(github.event.action == 'edited' && github.event.changes.title != null))")
  })
})
