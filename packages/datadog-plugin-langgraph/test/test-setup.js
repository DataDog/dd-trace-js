'use strict'

/**
 * Sample application for \@langchain/langgraph instrumentation testing.
 *
 * This app exercises the Pregel.invoke() and Pregel.stream() methods
 * which are the main entry points for running LangGraph workflows.
 */

/**
 * Sample app class for LangGraph instrumentation
 */
class LanggraphTestSetup {
  async setup (module) {
    this.module = module
    this.graph = null

    const { Annotation, StateGraph, START, END } = module

    /**
     * Define a simple state annotation for our graph.
     * This is the simplest way to define state in LangGraph.
     */
    const GraphState = Annotation.Root({
      counter: Annotation({
        reducer: (current, update) => (current || 0) + (update || 0),
        default: () => 0
      }),
      message: Annotation({
        reducer: (current, update) => update || current,
        default: () => ''
      })
    })

    this.GraphState = GraphState

    const builder = new StateGraph(GraphState)
      .addNode('increment', (state) => {
        return { counter: 1, message: 'incremented' }
      })
      .addNode('double', (state) => {
        return { counter: state.counter, message: 'doubled' } // Doubles by adding current value
      })
      .addEdge(START, 'increment')
      .addEdge('increment', 'double')
      .addEdge('double', END)

    this.graph = builder.compile()
  }

  async teardown () {
    this.graph = null
  }

  // --- Operations ---
  async pregelInvoke () {
    const result = await this.graph.invoke({
      counter: 5,
      message: 'start'
    })

    return result
  }

  async pregelInvokeError () {
    const { StateGraph, START, END } = this.module
    const errorBuilder = new StateGraph(this.GraphState)
      .addNode('error_node', () => {
        throw new Error('Intentional error for testing')
      })
      .addEdge(START, 'error_node')
      .addEdge('error_node', END)

    const errorGraph = errorBuilder.compile()
    await errorGraph.invoke({ counter: 0, message: 'error test' })
  }

  async pregelStream () {
    const stream = await this.graph.stream({
      counter: 10,
      message: 'stream start'
    })

    const results = []
    for await (const chunk of stream) {
      results.push(chunk)
    }

    return results
  }

  async pregelStreamError () {
    const { StateGraph, START, END } = this.module
    const errorBuilder = new StateGraph(this.GraphState)
      .addNode('error_node', () => {
        throw new Error('Intentional stream error for testing')
      })
      .addEdge(START, 'error_node')
      .addEdge('error_node', END)

    const errorGraph = errorBuilder.compile()
    const stream = await errorGraph.stream({ counter: 0, message: 'stream error test' })

    // eslint-disable-next-line no-unused-vars
    for await (const _ of stream) { /* pass */ }
  }
}

module.exports = LanggraphTestSetup
