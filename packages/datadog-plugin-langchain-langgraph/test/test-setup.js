'use strict'

class LangchainLanggraphTestSetup {
  async setup (module) {
    this.module = module
  }

  async teardown () {
    this.module = null
  }

  _buildGraph () {
    const { StateGraph, START, END, Annotation } = this.module

    const StateAnnotation = Annotation.Root({
      messages: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
    })

    const graph = new StateGraph(StateAnnotation)

    graph.addNode('greet', () => {
      return { messages: ['hello world'] }
    })

    graph.addEdge(START, 'greet')
    graph.addEdge('greet', END)

    return graph.compile()
  }

  _buildErrorGraph () {
    const { StateGraph, START, END, Annotation } = this.module

    const StateAnnotation = Annotation.Root({
      messages: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
    })

    const graph = new StateGraph(StateAnnotation)

    graph.addNode('fail', () => {
      throw new Error('Intentional error for testing')
    })

    graph.addEdge(START, 'fail')
    graph.addEdge('fail', END)

    return graph.compile()
  }

  async pregelStream () {
    const app = this._buildGraph()
    const stream = await app.stream({ messages: ['hi'] })
    // eslint-disable-next-line no-unused-vars
    for await (const chunk of stream) { /* noop */ }
  }

  async pregelStreamError () {
    const app = this._buildErrorGraph()
    const stream = await app.stream({ messages: ['hi'] })
    // eslint-disable-next-line no-unused-vars
    for await (const chunk of stream) { /* noop */ }
  }
}

module.exports = LangchainLanggraphTestSetup
