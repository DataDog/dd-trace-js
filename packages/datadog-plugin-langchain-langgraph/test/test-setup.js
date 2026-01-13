'use strict'

class LangchainLanggraphTestSetup {
  async setup (module) {
    this.workflow = null
    try {
      // Define the agent state
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

      // Create a new graph
      const workflow = new StateGraph({ channels: graphState })

      // Define node functions
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

      // Add nodes to the graph
      workflow.addNode('agent', callModel)

      // Add edges
      workflow.addEdge(START, 'agent')
      workflow.addConditionalEdges('agent', shouldContinue, {
        agent: 'agent',
        [END]: END
      })

      // Compile the graph
      this.workflow = workflow.compile()
    } catch (error) {
      throw error
    }
  }

  async teardown () {
    try {
      this.workflow = null
    } catch (error) {
    }
  }

  // --- Operations ---
  async pregelInvoke () {
    try {
      const input = {
        messages: ['User: What is the weather in SF?'],
        count: 0
      }
      const result = await this.workflow.invoke(input, {
        runName: 'test-invoke'
      })
      return result
    } catch (error) {
      throw error
    }
  }

  async pregelInvokeError () {
    try {
      // Intentionally pass invalid input to trigger error
      await this.workflow.invoke(null, {
        runName: 'test-invoke-error'
      })
    } catch (error) {
      throw error
    }
  }

  async runWithRetry () {
    try {
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
        // Simulate some work
        await new Promise(resolve => setTimeout(resolve, 10))
        return {
          attempts: attemptCount,
          result: 'success'
        }
      }

      retryWorkflow.addNode('simple', simpleNode)
      retryWorkflow.addEdge(START, 'simple')
      retryWorkflow.addEdge('simple', END)

      const compiled = retryWorkflow.compile()
      const result = await compiled.invoke({}, {
        runName: 'test-retry'
      })
    } catch (error) {
      throw error
    }
  }

  async runWithRetryError () {
    try {
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
    } catch (error) {
      throw error
    }
  }
}

module.exports = LangchainLanggraphTestSetup
