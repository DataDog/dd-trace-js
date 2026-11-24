'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')

/**
 * Watch real rewrite/activation events, including the subscriber count at each activation.
 * @param {string} publication
 * @returns {(count: number) => void}
 */
function checkActivation (publication) {
  const setupChannels = [
    'tracing:orchestrion:ai:getTracer:end',
    'tracing:orchestrion:ai:selectTelemetryAttributes:start',
    'tracing:orchestrion:ai:includeRuntimeContext:start',
    'tracing:orchestrion:ai:resolveLanguageModel:end',
  ].map(channel)
  const subscriptions = setupChannels.map(() => 0)
  const activations = []
  const rewrites = []
  for (const [index, ch] of setupChannels.entries()) {
    assert.strictEqual(ch.hasSubscribers, false)
    // Node switches the channel prototype on the first subscription.
    ch.subscribe(() => {})
    const subscribe = ch.subscribe
    ch.subscribe = function (listener) {
      subscriptions[index]++
      return subscribe.call(this, listener)
    }
  }
  channel(publication).subscribe(({ moduleName, package: pkg, result, activate }) => {
    if (moduleName === 'ai' || pkg === 'ai') rewrites.push(result ?? activate)
  })
  channel('dd-trace:instrumentation:load').subscribe(({ name }) => {
    if (name === 'ai') activations.push([...subscriptions])
  })

  return count => {
    const expectedRewrite = publication === 'dd-trace:bundler:load' ? true : 'rewritten'
    assert.deepStrictEqual(rewrites, Array(count).fill(expectedRewrite))
    assert.deepStrictEqual(activations, Array(count).fill([1, 1, 1, 1]))
    assert.deepStrictEqual(subscriptions, [1, 1, 1, 1])
  }
}

/**
 * @param {{ embed: (options: { model: object, value: string }) => Promise<{ embedding: number[] }> }} ai
 * @param {number} modelVersion
 */
async function checkEmbed (ai, modelVersion) {
  const spans = []
  const ends = channel('tracing:dd-trace:vercel-ai:asyncEnd')
  const onEnd = ({ name, currentStore }) => spans.push([name, Boolean(currentStore?.span)])
  ends.subscribe(onEnd)
  try {
    const model = {
      specificationVersion: `v${modelVersion}`,
      provider: 'fixture',
      modelId: 'embedding',
      maxEmbeddingsPerCall: 1,
      supportsParallelCalls: false,
      async doEmbed () {
        return { embeddings: [[1]], usage: { tokens: 1 }, warnings: [] }
      },
    }
    const result = await ai.embed({ model, value: 'hello' })
    assert.deepStrictEqual(result.embedding, [1])
    assert.deepStrictEqual(spans, [['ai.embed.doEmbed', true], ['ai.embed', true]])
  } finally {
    ends.unsubscribe(onEnd)
  }
}

/**
 * @param {{ streamText: (options: { model: object, prompt: string }) => { text: PromiseLike<string> } }} ai
 */
async function checkStream (ai) {
  const intercepted = []
  const chunks = []
  const completions = []
  channel('dd-trace:vercel-ai:model:intercept').subscribe(({ method }) => intercepted.push(method))
  channel('dd-trace:vercel-ai:chunk').subscribe(({ chunk, done }) => chunks.push([chunk.type, done]))
  channel('tracing:ai:telemetry:asyncEnd').subscribe(ctx => {
    if (ctx.type === 'languageModelCall' && ctx.streamConsumed) completions.push(ctx)
  })

  const model = {
    specificationVersion: 'v4',
    provider: 'fixture',
    modelId: 'language',
    supportedUrls: {},
    async doStream () {
      return { stream }
    },
  }
  const stream = new ReadableStream({
    start (controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] })
      controller.enqueue({ type: 'text-start', id: '1' })
      controller.enqueue({ type: 'text-delta', id: '1', delta: 'hello' })
      controller.enqueue({ type: 'text-end', id: '1' })
      controller.enqueue({
        type: 'finish',
        finishReason: { unified: 'stop' },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
      })
      controller.close()
    },
  })
  const result = ai.streamText({ model, prompt: 'hello' })
  assert.strictEqual(await result.text, 'hello')
  assert.deepStrictEqual(intercepted, ['doStream'])
  assert.deepStrictEqual(chunks, [
    ['stream-start', false],
    ['text-start', false],
    ['text-delta', false],
    ['text-end', false],
    ['finish', true],
  ])
  assert.strictEqual(completions.length, 1)
  assert.ok(completions[0].currentStore?.span)
  assert.strictEqual(completions[0].result.stream, stream)
}

module.exports = { checkActivation, checkEmbed, checkStream }
