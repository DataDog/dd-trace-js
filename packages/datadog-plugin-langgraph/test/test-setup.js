'use strict'

class LanggraphTestSetup {
  async setup (module) {
    this.workflow = null
    this.module = module

    const { StateGraph, START, END } = module
    this.StateGraph = StateGraph
    this.START = START
    this.END = END

    const graphState = {
      messages: {
        value: (x, y) => x.concat(y),
        default: () => []
      },
      count: {
        value: (x, y) => y,
        default: () => 0
      }
    }

    const workflow = new StateGraph({ channels: graphState })

    const callModel = async (state) => {
      const newMessage = `Response ${state.count + 1}`
      return {
        messages: state.messages.concat([newMessage]),
        count: state.count + 1
      }
    }

    const shouldContinue = (state) => {
      // Stop after 2 iterations
      return state.count >= 2 ? END : 'agent'
    }

    workflow.addNode('agent', callModel)

    workflow.addEdge(START, 'agent')
    workflow.addConditionalEdges('agent', shouldContinue, {
      agent: 'agent',
      [END]: END
    })

    this.workflow = workflow.compile()
  }

  async teardown () {
    this.workflow = null
  }

  async pregelInvoke () {
    const input = {
      messages: ['User: What is the weather in SF?'],
      count: 0
    }
    const result = await this.workflow.invoke(input, {
      runName: 'test-invoke'
    })
    return result
  }

  async pregelInvokeError () {
    // Intentionally pass invalid input to trigger error
    await this.workflow.invoke(null, {
      runName: 'test-invoke-error'
    })
  }

  async pregelStream () {
    const input = {
      messages: ['User: What is the weather in SF?'],
      count: 0
    }
    const chunks = []
    const stream = await this.workflow.stream(input, {
      runName: 'test-stream'
    })
    for await (const chunk of stream) {
      chunks.push(chunk)
    }
    return chunks
  }

  async pregelStreamError () {
    // Intentionally pass invalid input to trigger error
    const stream = await this.workflow.stream(null, {
      runName: 'test-stream-error'
    })
    // eslint-disable-next-line no-unused-vars
    for await (const _ of stream) {
      // This should throw during iteration
    }
  }

  async runWithRetry () {
    const { StateGraph, START, END } = this.module
    // Create a simple workflow to test node execution
    const graphState = {
      attempts: {
        value: (x, y) => y,
        default: () => 0
      },
      result: {
        value: (x, y) => y,
        default: () => null
      }
    }

    const retryWorkflow = new StateGraph({ channels: graphState })

    let attemptCount = 0
    const simpleNode = async (state) => {
      attemptCount++
      return {
        attempts: attemptCount,
        result: 'success'
      }
    }

    retryWorkflow.addNode('simple', simpleNode)
    retryWorkflow.addEdge(START, 'simple')
    retryWorkflow.addEdge('simple', END)

    const compiled = retryWorkflow.compile()
    await compiled.invoke({}, {
      runName: 'test-retry'
    })
  }

  async runWithRetryError () {
    const { StateGraph, START, END } = this.module
    const graphState = {
      count: {
        value: (x, y) => y,
        default: () => 0
      }
    }

    const errorWorkflow = new StateGraph({ channels: graphState })

    const errorNode = async (state) => {
      throw new Error('Intentional node error for testing')
    }

    errorWorkflow.addNode('error', errorNode)
    errorWorkflow.addEdge(START, 'error')
    errorWorkflow.addEdge('error', END)

    const compiled = errorWorkflow.compile()
    await compiled.invoke({}, {
      runName: 'test-retry-error'
    })
  }
}

module.exports = LanggraphTestSetup
