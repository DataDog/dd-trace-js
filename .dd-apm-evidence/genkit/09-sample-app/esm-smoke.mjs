'use strict'

/* eslint-disable no-console */
/* eslint-disable n/no-extraneous-require */
/* eslint-disable require-await */

import { genkit } from 'genkit'

const ai = genkit({ name: 'datadog-genkit-esm-smoke' })
const model = ai.defineModel({ name: 'local/esm-model' }, async () => ({
  message: { role: 'model', content: [{ text: 'ESM generation complete.' }] },
  finishReason: 'stop',
  usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
}))

const response = await ai.generate({ model, prompt: 'Exercise the public ESM import.' })
console.log(JSON.stringify({ moduleFormat: 'esm', output: response.text }))
