'use strict'

const assert = require('node:assert/strict')

const { getAllInstrumentations, getInstrumentation, getInstrumentationNames } = require('./load-inst')

describe('load-inst', () => {
  it('discovers an Orchestrion-only instrumentation without a runtime module', () => {
    const instrumentations = getInstrumentation('bullmq')

    assert.deepStrictEqual(
      [...new Set(instrumentations.map(({ name, versions }) => `${name}:${versions.join()}`))],
      ['bullmq:>=5.66.0']
    )
  })

  it('includes Orchestrion-only integrations in the complete registry', () => {
    const names = getInstrumentationNames()
    const instrumentations = getAllInstrumentations()

    assert.ok(names.includes('bullmq'))
    assert.ok(names.includes('langchain'))
    assert.ok(names.includes('langgraph'))
    assert.ok(instrumentations.bullmq)
    assert.ok(instrumentations.langchain)
    assert.ok(instrumentations.langgraph)
  })

  it('does not duplicate declarations shared by addHook and Orchestrion', () => {
    const instrumentations = getInstrumentation('graphql')
    const declarations = instrumentations.map(({ name, versions, file }) => `${name}:${versions.join()}:${file}`)

    assert.strictEqual(declarations.length, new Set(declarations).size)
  })
})
