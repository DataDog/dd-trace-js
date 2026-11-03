export default {
  specificationVersion: 'v3',
  provider: 'vite-test',
  modelId: 'vite-test',
  supportedUrls: {},
  doGenerate () {
    return Promise.resolve({
      content: [{ type: 'text', text: 'ok' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 1 },
        outputTokens: { total: 1 },
      },
      warnings: [],
    })
  },
}
