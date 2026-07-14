'use strict'

/* eslint-disable no-console */
/* eslint-disable n/no-extraneous-require */
/* eslint-disable require-await, no-useless-catch */

const fs = require('node:fs')
const path = require('node:path')

const { genkit } = require('genkit/beta')

const RESULTS_PATH = process.env.RESULTS_PATH || path.join(__dirname, 'sample-results.json')

class GenkitSampleApp {
  constructor () {
    this.ai = genkit({ name: 'datadog-genkit-offline-sample' })
    this.results = []
    this.events = []
  }

  async setup () {
    this.lookupTool = this.ai.defineTool({
      name: 'lookupWeather',
      description: 'Looks up deterministic local weather data.',
    }, async ({ city }) => {
      this.events.push('tool-lookupWeather')
      return { city, forecast: 'sunny', temperatureCelsius: 21 }
    })

    this.failingTool = this.ai.defineTool({
      name: 'failingTool',
      description: 'Always rejects for error instrumentation evidence.',
    }, async () => {
      throw new Error('intentional tool runner failure')
    })

    this.interruptTool = this.ai.defineTool({
      name: 'approvalRequired',
      description: 'Interrupts to request deterministic local approval.',
    }, async (input, { interrupt }) => {
      interrupt({ reason: 'sample approval required', input })
    })

    this.model = this.ai.defineModel({
      name: 'local/offline-model',
      label: 'Offline deterministic model',
      supports: { tools: true, toolChoice: true },
    }, async (request, sendChunk) => {
      const content = request.messages.flatMap(message => message.content)
      const hasToolResponse = content.some(part => part.toolResponse?.name === 'lookupWeather')
      const prompt = content.map(part => part.text || '').join(' ')
      this.events.push(hasToolResponse ? 'model-turn-2' : 'model-turn-1')

      if (prompt.includes('MODEL_RUNNER_ERROR')) {
        throw new Error('intentional model runner failure')
      }

      if (request.tools?.some(tool => tool.name === 'approvalRequired')) {
        return {
          message: {
            role: 'model',
            content: [{ toolRequest: { name: 'approvalRequired', ref: 'approval-1', input: { task: 'deploy' } } }],
          },
          finishReason: 'stop',
          usage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 },
        }
      }

      if (request.tools?.some(tool => tool.name === 'lookupWeather') && !hasToolResponse) {
        return {
          message: {
            role: 'model',
            content: [{ toolRequest: { name: 'lookupWeather', ref: 'weather-1', input: { city: 'Paris' } } }],
          },
          finishReason: 'stop',
          usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
        }
      }

      if (sendChunk) {
        await new Promise(resolve => setTimeout(resolve, 5))
        sendChunk({ content: [{ text: 'offline ' }] })
        await new Promise(resolve => setTimeout(resolve, 5))
        sendChunk({ content: [{ text: 'stream complete' }] })
      }

      const text = hasToolResponse ? 'The Paris forecast is sunny at 21C.' : 'Offline generation complete.'
      return {
        message: { role: 'model', content: [{ text }] },
        finishReason: 'stop',
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      }
    })

    this.retriever = this.ai.defineRetriever({ name: 'localRetriever' }, async query => ({
      documents: [{
        content: [{ text: `Retrieved context for: ${query.text}` }],
        metadata: { name: 'offline-document', id: 'doc-1', score: 0.91, excludedSecret: 'do-not-capture' },
      }],
    }))

    this.failingRetriever = this.ai.defineRetriever({ name: 'failingRetriever' }, async () => {
      throw new Error('intentional retriever runner failure')
    })

    this.embedder = this.ai.defineEmbedder({
      name: 'localEmbedder',
      info: { label: 'Offline deterministic embedder', dimensions: 3 },
    }, async documents => ({
      embeddings: documents.map((document, index) => ({
        embedding: [index + 0.1, index + 0.2, index + 0.3],
        metadata: { excludedSecret: 'do-not-capture' },
      })),
    }))

    this.failingEmbedder = this.ai.defineEmbedder({ name: 'failingEmbedder' }, async () => {
      throw new Error('intentional embedder runner failure')
    })

    this.flow = this.ai.defineFlow({ name: 'offlineWorkflow' }, async input => {
      return this.ai.run('offlineFlowStep', input, async stepInput => {
        const firstEventIndex = this.events.length
        const documents = await this.ai.retrieve({ retriever: this.retriever, query: stepInput.query })
        const embeddings = await this.ai.embedMany({
          embedder: this.embedder,
          content: ['first embedding input', 'second embedding input'],
        })
        const generation = await this.ai.generate({
          model: this.model,
          prompt: `Use a tool for ${stepInput.city}`,
          tools: [this.lookupTool],
          maxTurns: 2,
        })
        return {
          answer: generation.text,
          documentCount: documents.length,
          embeddingCount: embeddings.length,
          toolLoopEvents: this.events.slice(firstEventIndex),
        }
      })
    })

    this.failingFlow = this.ai.defineFlow({ name: 'failingWorkflow' }, async () => {
      throw new Error('intentional flow runner failure')
    })

    console.log('setup: registered local Genkit 1.21.0 actions')
  }

  async record (name, operation, expectedError = false) {
    const startedAt = new Date().toISOString()
    try {
      const value = await operation()
      const result = { name, status: 'success', expectedError, startedAt, completedAt: new Date().toISOString(), value }
      this.results.push(result)
      console.log(JSON.stringify(result))
      return value
    } catch (error) {
      const result = {
        name,
        status: expectedError ? 'expected_error' : 'unexpected_error',
        expectedError,
        startedAt,
        completedAt: new Date().toISOString(),
        error: { name: error.name, message: error.message },
      }
      this.results.push(result)
      console.log(JSON.stringify(result))
      return undefined
    }
  }

  async generation () {
    try {
      return await this.ai.generate({ model: this.model, prompt: 'Generate a deterministic offline response.' })
    } catch (error) {
      throw error
    }
  }

  async generationError () {
    try {
      return await this.ai.generate({ model: this.model, prompt: 'MODEL_RUNNER_ERROR' })
    } catch (error) {
      throw error
    }
  }

  async generationStream () {
    try {
      const { response, stream } = this.ai.generateStream({ model: this.model, prompt: 'Stream offline.' })
      const chunks = []
      for await (const chunk of stream) {
        chunks.push(chunk.text)
      }
      const finalResponse = await response
      return {
        chunkCount: chunks.length,
        chunkOrder: chunks,
        streamCompleted: true,
        finalResponseAwaited: true,
        finalOutput: finalResponse.text,
      }
    } catch (error) {
      throw error
    }
  }

  async generationStreamError () {
    try {
      const { response, stream } = this.ai.generateStream({ model: this.model, prompt: 'MODEL_RUNNER_ERROR' })
      for await (const chunk of stream) console.log(chunk.text)
      return await response
    } catch (error) {
      throw error
    }
  }

  async workflow () {
    try {
      return await this.flow({ query: 'Genkit tracing', city: 'Paris' })
    } catch (error) {
      throw error
    }
  }

  async workflowError () {
    try {
      return await this.failingFlow({ reason: 'exercise error path' })
    } catch (error) {
      throw error
    }
  }

  async flowStepError () {
    try {
      return await this.ai.run('failingFlowStep', { requested: true }, async () => {
        throw new Error('intentional flow step failure')
      })
    } catch (error) {
      throw error
    }
  }

  async tool () {
    try {
      return await this.lookupTool({ city: 'Berlin' })
    } catch (error) {
      throw error
    }
  }

  async toolError () {
    try {
      return await this.failingTool({ requested: true })
    } catch (error) {
      throw error
    }
  }

  async toolInterrupt () {
    try {
      const response = await this.ai.generate({
        model: this.model,
        prompt: 'Request approval.',
        tools: [this.interruptTool],
        maxTurns: 1,
      })
      return {
        finishReason: response.finishReason,
        finishMessage: response.finishMessage,
        message: response.message.toJSON(),
      }
    } catch (error) {
      throw error
    }
  }

  async retrieval () {
    try {
      const documents = await this.ai.retrieve({ retriever: this.retriever, query: 'offline retrieval query' })
      return documents.map(document => ({ text: document.text, metadata: document.metadata }))
    } catch (error) {
      throw error
    }
  }

  async retrievalError () {
    try {
      return await this.ai.retrieve({ retriever: this.failingRetriever, query: 'trigger failure' })
    } catch (error) {
      throw error
    }
  }

  async embedding () {
    try {
      const embeddings = await this.ai.embedMany({
        embedder: this.embedder,
        content: ['first input document', 'second input document'],
      })
      return { count: embeddings.length, dimensions: embeddings.map(value => value.embedding.length) }
    } catch (error) {
      throw error
    }
  }

  async embeddingError () {
    try {
      return await this.ai.embedMany({ embedder: this.failingEmbedder, content: ['trigger failure'] })
    } catch (error) {
      throw error
    }
  }

  async teardown () {
    const unexpectedErrors = this.results.filter(result => result.status === 'unexpected_error')
    const packageRoot = path.dirname(path.dirname(require.resolve('genkit')))
    const packageVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version
    const evidence = {
      schemaVersion: 1,
      package: 'genkit',
      version: packageVersion,
      nodeVersion: process.version,
      moduleFormat: 'commonjs',
      completedAt: new Date().toISOString(),
      unexpectedErrorCount: unexpectedErrors.length,
      operations: this.results,
    }
    fs.writeFileSync(RESULTS_PATH, `${JSON.stringify(evidence, null, 2)}\n`)
    console.log(`teardown: wrote ${RESULTS_PATH}`)
    if (unexpectedErrors.length) process.exitCode = 1
  }

  async runAll () {
    try {
      await this.setup()
      await this.record('generation', () => this.generation())
      await this.record('generationError', () => this.generationError(), true)
      await this.record('generationStream', () => this.generationStream())
      await this.record('generationStreamError', () => this.generationStreamError(), true)
      await this.record('workflow', () => this.workflow())
      await this.record('workflowError', () => this.workflowError(), true)
      await this.record('flowStepError', () => this.flowStepError(), true)
      await this.record('tool', () => this.tool())
      await this.record('toolError', () => this.toolError(), true)
      await this.record('toolInterrupt', () => this.toolInterrupt())
      await this.record('retrieval', () => this.retrieval())
      await this.record('retrievalError', () => this.retrievalError(), true)
      await this.record('embedding', () => this.embedding())
      await this.record('embeddingError', () => this.embeddingError(), true)
    } finally {
      await this.teardown()
    }
  }
}

new GenkitSampleApp().runAll().catch(error => {
  console.error(error)
  process.exitCode = 1
})
