import assert from 'node:assert/strict'
import fs from 'node:fs'

import { describe, it } from 'mocha'
import YAML from 'yaml'

const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/pr-title.yml', import.meta.url), 'utf8'))
const job = workflow.jobs['conventional-commit']
const steps = new Map()
for (const step of job.steps) steps.set(step.name, step)

const checkout = steps.get('Checkout base revision')

describe('PR title workflow', () => {
  it('checks out the workflow revision', () => {
    assert.strictEqual(checkout.with.ref, '$' + '{{ github.sha }}')
  })
})
