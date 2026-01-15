'use strict'

/**
 * Sample app for \@langchain/langgraph instrumentation testing.
 * This creates a simple workflow graph to test Pregel.invoke() and Pregel.stream().
 */

class LangchainLanggraphTestSetup {
  async setup (module) {
    this.module = module
    this.graph = null

    const { Annotation, StateGraph, START, END } = module

    const StateAnnotation = Annotation.Root({
      messages: Annotation({
        reducer: (left, right) => {
          if (Array.isArray(right)) {
            return (left || []).concat(right)
          }
          return (left || []).concat([right])
        },
        default: () => []
      }),
      count: Annotation({
        reducer: (left, right) => (left || 0) + right,
        default: () => 0
      }),
      status: Annotation({
        default: () => 'pending'
      })
    })

    const graphBuilder = new StateGraph(StateAnnotation)

    graphBuilder.addNode('processInput', (state) => {
      return {
        messages: ['Input processed'],
        count: 1,
        status: 'processing'
      }
    })

    graphBuilder.addNode('analyze', (state) => {
      return {
        messages: ['Analysis complete'],
        count: 1,
        status: 'analyzed'
      }
    })

    graphBuilder.addNode('generateOutput', (state) => {
      return {
        messages: [`Final count: ${state.count + 1}`],
        count: 1,
        status: 'completed'
      }
    })

    graphBuilder.addEdge(START, 'processInput')
    graphBuilder.addEdge('processInput', 'analyze')
    graphBuilder.addEdge('analyze', 'generateOutput')
    graphBuilder.addEdge('generateOutput', END)

    // Compile the graph - this creates a CompiledStateGraph that extends Pregel
    this.graph = graphBuilder.compile()
  }

  async teardown () {
    this.graph = null
  }

  async pregelInvoke () {
    const result = await this.graph.invoke({
      messages: ['Hello from sample app!']
    })
    return result
  }

  async pregelInvokeError () {
    const { Annotation, StateGraph, START, END } = this.module

    const ErrorStateAnnotation = Annotation.Root({
      value: Annotation({ default: () => null })
    })

    const errorGraphBuilder = new StateGraph(ErrorStateAnnotation)
    errorGraphBuilder.addNode('errorNode', () => {
      throw new Error('Test error')
    })
    errorGraphBuilder.addEdge(START, 'errorNode')
    errorGraphBuilder.addEdge('errorNode', END)

    const errorGraph = errorGraphBuilder.compile()
    await errorGraph.invoke({ value: 'test' })
  }

  async pregelStream () {
    const stream = await this.graph.stream({
      messages: ['Streaming test message!']
    })

    const chunks = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }

    return chunks
  }

  async pregelStreamError () {
    const { Annotation, StateGraph, START, END } = this.module

    const ErrorStateAnnotation = Annotation.Root({
      value: Annotation({ default: () => null })
    })

    const errorGraphBuilder = new StateGraph(ErrorStateAnnotation)
    errorGraphBuilder.addNode('errorNode', () => {
      throw new Error('Intentional stream error for testing')
    })
    errorGraphBuilder.addEdge(START, 'errorNode')
    errorGraphBuilder.addEdge('errorNode', END)

    const errorGraph = errorGraphBuilder.compile()
    const stream = await errorGraph.stream({ value: 'test' })

    // Drain the stream to ensure the operation completes
    // eslint-disable-next-line no-unused-vars
    for await (const chunk of stream) {
      // Intentionally empty
    }
  }
}

module.exports = LangchainLanggraphTestSetup
