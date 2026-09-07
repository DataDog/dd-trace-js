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
  async setup (module, tool, zod) {
    this.app = null
    this.module = module
    this.tool = tool
    this.zod = zod
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
    return this.app.invoke(input)
  }

  async pregelInvokeError () {
    // Create a separate error graph that throws
    const { Annotation, StateGraph, START, END } = this.module
    const StateAnnotation = Annotation.Root({
      messages: Annotation({
        default: () => [],
        reducer: (prev, next) => [...prev, ...next],
      }),
    })

    const errorGraph = new StateGraph(StateAnnotation)
    errorGraph.addNode('error', (state) => {
      throw new Error('Intentional test error')
    })
    errorGraph.addEdge(START, 'error')
    errorGraph.addEdge('error', END)

    const errorApp = errorGraph.compile()
    await errorApp.invoke({ messages: ['test'] })
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
    // Use the happy path graph but manually trigger error via iterator.throw()
    const input = { messages: ['streaming test'] }
    const stream = await this.app.stream(input)

    // Get the iterator and manually throw an error
    const iterator = stream[Symbol.asyncIterator]()

    // Consume one chunk first to start the stream
    await iterator.next()

    // Now manually throw an error using the iterator's throw method
    // This will trigger the instrumentation's error handling (line 82-91 in internal.js)
    if (iterator.throw) {
      await iterator.throw(new Error('Intentional test error')).catch(() => {})
    } else {
      throw new Error('Intentional test error')
    }
  }

  /**
   * Runs a tool-backed graph through interrupt and resume.
   * @returns {Promise<{resumed: {result: string}, suspended: {__interrupt__: object[]}}>} Graph results.
   */
  async graphInterrupt () {
    const { Annotation, Command, END, interrupt, MemorySaver, START, StateGraph } = this.module
    const StateAnnotation = Annotation.Root({
      result: Annotation(),
    })
    const askForApproval = this.tool(
      ({ action }) => {
        const approved = interrupt({ question: `Approve this action: ${action}?` })
        return approved ? 'The action was approved.' : 'The action was rejected.'
      },
      {
        name: 'ask_for_approval',
        description: 'Ask a human to approve an action',
        schema: this.zod.object({ action: this.zod.string() }),
      }
    )

    const graph = new StateGraph(StateAnnotation)
      .addNode('approval', async () => ({
        result: await askForApproval.invoke({ action: 'deploy to production' }),
      }))
      .addEdge(START, 'approval')
      .addEdge('approval', END)

    const app = graph.compile({ checkpointer: new MemorySaver(), name: 'interruptGraph' })
    const config = { configurable: { thread_id: 'graph-interrupt-test' } }
    const suspended = await app.invoke({}, config)
    const resumed = await app.invoke(new Command({ resume: true }), config)

    return { resumed, suspended }
  }
}

module.exports = LanggraphTestSetup
