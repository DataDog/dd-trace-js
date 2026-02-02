'use strict'

/**
 * Sample application for `@langchain/langgraph` instrumentation testing.
 * Tests the Pregel class methods: invoke and stream.
 */
// Import necessary symbols from @langchain/langgraph
/**
 * Sample application class for testing langgraph instrumentation.
 * Creates a simple graph workflow to test Pregel.invoke() and Pregel.stream().
 */

class LanggraphTestSetup {
  async setup (module) {
    this.app = null
    // Destructure required symbols from the langgraph module
    const { Annotation, StateGraph, START, END } = module
    // Define state annotation with messages array
    const StateAnnotation = Annotation.Root({
      messages: Annotation({
        default: () => [],
        reducer: (prev, next) => [...prev, ...next],
      }),
      step: Annotation({
        default: () => 0,
        reducer: (prev, next) => next,
      }),
    })

    // Create a new StateGraph
    const graph = new StateGraph(StateAnnotation)

    // Add processing nodes
    graph.addNode('preprocess', (state) => {
      return {
        messages: ['preprocessed'],
        step: 1,
      }
    })

    graph.addNode('process', (state) => {
      return {
        messages: ['processed'],
        step: 2,
      }
    })

    graph.addNode('postprocess', (state) => {
      return {
        messages: ['completed'],
        step: 3,
      }
    })

    // Define edges
    graph.addEdge(START, 'preprocess')
    graph.addEdge('preprocess', 'process')
    graph.addEdge('process', 'postprocess')
    graph.addEdge('postprocess', END)

    // Compile the graph to get a Pregel instance
    this.app = graph.compile()
  }

  async teardown () {
    this.app = null
  }

  // --- Operations ---
  async pregelInvoke () {
    const input = { messages: ['hello world'] }
    const result = await this.app.invoke(input)

    return result
  }

  async pregelInvokeError () {
    // Try to invoke with invalid recursion limit to trigger error
    await this.app.invoke(
      { messages: ['test'] },
      { recursionLimit: -1 } // Invalid negative limit
    )
  }

  async pregelStream () {
    const input = { messages: ['streaming test'] }
    const stream = await this.app.stream(input)

    const chunks = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }

    return chunks
  }

  async pregelStreamError () {
    // Try to stream with invalid recursion limit to trigger error
    const stream = await this.app.stream(
      { messages: ['test'] },
      { recursionLimit: -1 } // Invalid negative limit
    )

    // Consume stream to trigger any deferred errors
    // eslint-disable-next-line no-unused-vars
    for await (const _ of stream) {
      /* pass */
    }
  }
}

module.exports = LanggraphTestSetup
