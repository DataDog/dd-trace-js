'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const yaml = require('yaml')

test('workflow gates actual PR/backport revisions with no new schedule or privileged PR trigger', () => {
  const file = path.resolve(__dirname, '../../../.github/workflows/lambda-shim-compat.yml')
  const workflow = yaml.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(workflow.on.pull_request.branches, ['master', 'v5.x', 'v6.x'])
  assert.equal(workflow.on.schedule, undefined)
  assert.equal(workflow.on.pull_request_target, undefined)
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  const aggregate = workflow.jobs['lambda-shim-compat']
  assert.equal(aggregate.if, 'always()')
  assert.deepEqual(aggregate.needs, ['prepare', 'compatibility'])
  assert.match(aggregate.steps[0].run, /PREPARE_RESULT.*success.*COMPAT_RESULT.*success/)
  assert.equal(workflow.jobs.compatibility.strategy['fail-fast'], false)
  for (const job of [workflow.jobs.prepare, workflow.jobs.compatibility]) {
    const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'))
    assert.equal(checkout.with.ref, undefined, 'Do not replace the PR revision with a release branch head')
    assert.equal(checkout.with['persist-credentials'], false)
  }
})
