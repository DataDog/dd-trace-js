'use strict'

const assert = require('node:assert')

const { describe, it } = require('mocha')

const { useLlmObs } = require('../util')

// The SDK resolves the nearest agent ancestor at span registration (a one-level lookup that
// inherits the parent's already-resolved attribution) and surfaces it as `meta.agent_attribution`
// only on spans that have an agent ancestor. Spans with no agent ancestor omit the block entirely.
// This mirrors dd-trace-py's tests/llmobs/test_llmobs_agent_attribution.py case for case.
describe('llmobs agent attribution', () => {
  const { getEvents } = useLlmObs()

  let tracer, llmobs
  before(() => {
    tracer = global._ddtrace
    llmobs = tracer.llmobs
  })

  function eventByName (llmobsSpans, name) {
    const matches = llmobsSpans.filter(event => event.name === name)
    assert.strictEqual(matches.length, 1, `expected exactly one event named ${name}, got ${matches.length}`)
    return matches[0]
  }

  it('attributes a tool under an agent to the agent', async () => {
    llmobs.trace({ kind: 'agent', name: 'my_agent' }, () => {
      llmobs.trace({ kind: 'tool', name: 'my_tool' }, () => {})
    })

    const { llmobsSpans } = await getEvents(2)
    const agentEvent = eventByName(llmobsSpans, 'my_agent')
    const toolEvent = eventByName(llmobsSpans, 'my_tool')

    assert.deepStrictEqual(toolEvent.meta.agent_attribution, {
      parent_agent_name: 'my_agent',
      parent_agent_span_id: agentEvent.span_id,
    })
  })

  it('attributes indirectly nested spans to the nearest agent', async () => {
    // agent -> workflow -> tool: the workflow and the tool both attribute to the agent.
    llmobs.trace({ kind: 'agent', name: 'my_agent' }, () => {
      llmobs.trace({ kind: 'workflow', name: 'my_workflow' }, () => {
        llmobs.trace({ kind: 'tool', name: 'my_tool' }, () => {})
      })
    })

    const { llmobsSpans } = await getEvents(3)
    const expected = {
      parent_agent_name: 'my_agent',
      parent_agent_span_id: eventByName(llmobsSpans, 'my_agent').span_id,
    }

    assert.deepStrictEqual(eventByName(llmobsSpans, 'my_workflow').meta.agent_attribution, expected)
    assert.deepStrictEqual(eventByName(llmobsSpans, 'my_tool').meta.agent_attribution, expected)
  })

  it('attributes a sub-agent and its children to the enclosing agent', async () => {
    // An agent nested under an agent attributes to the enclosing agent, never itself.
    llmobs.trace({ kind: 'agent', name: 'outer_agent' }, () => {
      llmobs.trace({ kind: 'agent', name: 'inner_agent' }, () => {
        llmobs.trace({ kind: 'tool', name: 'inner_tool' }, () => {})
      })
    })

    const { llmobsSpans } = await getEvents(3)
    const outerId = eventByName(llmobsSpans, 'outer_agent').span_id
    const innerId = eventByName(llmobsSpans, 'inner_agent').span_id

    assert.deepStrictEqual(eventByName(llmobsSpans, 'inner_agent').meta.agent_attribution, {
      parent_agent_name: 'outer_agent',
      parent_agent_span_id: outerId,
    })
    // The tool's nearest agent ancestor is the inner agent.
    assert.deepStrictEqual(eventByName(llmobsSpans, 'inner_tool').meta.agent_attribution, {
      parent_agent_name: 'inner_agent',
      parent_agent_span_id: innerId,
    })
  })

  it('omits the block on a top-level agent', async () => {
    llmobs.trace({ kind: 'agent', name: 'root_agent' }, () => {})

    const { llmobsSpans } = await getEvents(1)
    assert.ok(!('agent_attribution' in eventByName(llmobsSpans, 'root_agent').meta))
  })

  it('omits the block on a top-level llm', async () => {
    llmobs.trace({ kind: 'llm', name: 'root_llm' }, () => {})

    const { llmobsSpans } = await getEvents(1)
    assert.ok(!('agent_attribution' in eventByName(llmobsSpans, 'root_llm').meta))
  })

  it('omits the block when there is no agent in the chain', async () => {
    // A workflow with a tool but no agent anywhere: neither gets the block.
    llmobs.trace({ kind: 'workflow', name: 'lonely_workflow' }, () => {
      llmobs.trace({ kind: 'tool', name: 'lonely_tool' }, () => {})
    })

    const { llmobsSpans } = await getEvents(2)
    assert.ok(!('agent_attribution' in eventByName(llmobsSpans, 'lonely_workflow').meta))
    assert.ok(!('agent_attribution' in eventByName(llmobsSpans, 'lonely_tool').meta))
  })

  it('stringifies the parent agent span id', async () => {
    let agentSpanId
    llmobs.trace({ kind: 'agent', name: 'my_agent' }, span => {
      agentSpanId = span.context().toSpanId()
      llmobs.trace({ kind: 'tool', name: 'my_tool' }, () => {})
    })

    const { llmobsSpans } = await getEvents(2)
    const attribution = eventByName(llmobsSpans, 'my_tool').meta.agent_attribution

    assert.strictEqual(typeof attribution.parent_agent_span_id, 'string')
    assert.strictEqual(attribution.parent_agent_span_id, agentSpanId)
  })
})
