'use strict'

const MODEL_NAME = 'echo/model'

let defineActionCounter = 0

class GenkitTestSetup {
  async setup (module) {
    const { genkit, Session } = module

    this._ai = genkit({})

    this._echoModel = this._ai.defineModel(
      {
        name: MODEL_NAME,
        supports: { multiturn: true, tools: false, media: false, systemRole: true, output: ['text'] }
      },
      async function echoModelRunner (request) {
        const lastMessage = request.messages[request.messages.length - 1]
        const text = lastMessage.content.map(function (c) { return c.text || '' }).join('')
        return {
          message: { role: 'model', content: [{ text: 'Echo: ' + text }] },
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
        }
      }
    )

    this._Session = Session
  }

  async teardown () {
    this._ai = undefined
    this._echoModel = undefined
    this._Session = undefined
  }

  /**
   * Returns the model name used for peer service assertions.
   *
   * @returns {string}
   */
  expectedModelName () {
    return MODEL_NAME
  }

  // --- Operations ---

  async genkitAIGenerate () {
    return this._ai.generate({ model: this._echoModel, prompt: 'What is the capital of France?' })
  }

  async genkitAIGenerateError () {
    return this._ai.generate({ model: 'nonexistent/model-that-does-not-exist', prompt: 'This should fail' })
  }

  async genkitAIGenerateStream () {
    const streamResult = this._ai.generateStream({ model: this._echoModel, prompt: 'Tell me a short story' })
    return streamResult.response
  }

  async genkitAIGenerateStreamError () {
    const streamResult = this._ai.generateStream({
      model: 'nonexistent/model-that-does-not-exist',
      prompt: 'This should fail'
    })
    return streamResult.response
  }

  async chatSend () {
    const session = new this._Session(this._ai.registry)
    const chat = session.chat({ model: this._echoModel })
    return chat.send('Hello, who are you?')
  }

  async chatSendError () {
    const session = new this._Session(this._ai.registry)
    const chat = session.chat({ model: 'nonexistent/model-that-does-not-exist' })
    return chat.send('This should fail')
  }

  defineAction () {
    // defineAction fires synchronously when defining a new model/action
    const name = `test/define-action-model-${++defineActionCounter}`
    this._ai.defineModel(
      {
        name,
        supports: { multiturn: false, tools: false, media: false, systemRole: false, output: ['text'] }
      },
      async function testRunner () {
        return {
          message: { role: 'model', content: [{ text: 'test' }] },
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
        }
      }
    )
  }

  defineActionError () {
    // defineAction fires synchronously when defining a new model/action.
    // The registration itself succeeds; we just verify a span is created.
    const name = `test/define-action-error-model-${++defineActionCounter}`
    this._ai.defineModel(
      {
        name,
        supports: { multiturn: false, tools: false, media: false, systemRole: false, output: ['text'] }
      },
      async function errorRunner () {
        throw new Error('defineAction test error')
      }
    )
  }
}

module.exports = GenkitTestSetup
