import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

import { describe, it } from 'mocha'
import YAML from 'yaml'

const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/pr-title.yml', import.meta.url), 'utf8'))
const job = workflow.jobs['conventional-commit']
const steps = new Map()
for (const step of job.steps) steps.set(step.name, step)

const checkout = steps.get('Checkout base revision')
const validation = steps.get('Validate PR title and release-note context')
const labelSync = steps.get('Sync labels with PR title')
const validateTitle = vm.runInNewContext(
  `(async function validateTitle (context, core, github, process, require) {\n${validation.with.script}\n})`
)
const releaseHelpers = {
  appendChangedPaths: Function.prototype,
  isInternalOnly: () => false,
}
const loadReleaseHelpers = () => releaseHelpers

describe('PR title workflow', () => {
  it('lists changed files only for public title types', async () => {
    const expectedCallsByType = new Map([
      ['feat', 1],
      ['fix', 1],
      ['perf', 1],
      ['docs', 1],
      ['style', 0],
      ['refactor', 0],
      ['test', 0],
      ['bench', 0],
      ['build', 0],
      ['ci', 0],
      ['chore', 0],
      ['revert', 0],
    ])
    const validations = []

    for (const [type, expectedCalls] of expectedCallsByType) {
      let listFilesCalls = 0
      const context = {
        repo: { owner: 'DataDog', repo: 'dd-trace-js' },
        payload: { pull_request: { number: 1, title: `${type}: change` } },
      }
      const core = {
        info: Function.prototype,
        setFailed: assert.fail,
      }
      const github = {
        paginate: () => {
          listFilesCalls++
          return []
        },
        rest: { pulls: { listFiles: Function.prototype } },
      }
      const process = { env: { PR_TITLE_PATTERN: job.env.PR_TITLE_PATTERN } }

      validations.push(validateTitle(context, core, github, process, loadReleaseHelpers))

      assert.strictEqual(listFilesCalls, expectedCalls, type)
    }

    await Promise.all(validations)
  })

  it('syncs labels only for events that can require reconciliation', () => {
    assert.strictEqual(labelSync.if.replaceAll(/\s+/g, ' '),
      "steps.rename.outputs.renamed != 'true' && " +
      "(github.event.action == 'opened' || " +
      "github.event.action == 'reopened' || " +
      "(github.event.action == 'edited' && github.event.changes.title != null))")
  })

  it('checks out the workflow revision', () => {
    assert.strictEqual(checkout.with.ref, '$' + '{{ github.sha }}')
  })
})
