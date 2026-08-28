'use strict'

module.exports = {
  specificationVersion: 'v3',
  provider: 'turbopack-test',
  modelId: 'turbopack-test',
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
