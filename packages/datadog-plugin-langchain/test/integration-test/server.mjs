import 'dd-trace/init.js'
import { OpenAI } from '@langchain/openai'
import { StringOutputParser } from '@langchain/core/output_parsers'
import nock from 'nock'

nock('https://api.openai.com:443')
  .post('/v1/completions')
  .reply(200, {}, [
    'Date', 'Mon, 15 May 2023 17:24:22 GMT',
    'Content-Type', 'application/json',
    'Content-Length', '349',
    'Connection', 'close',
    'openai-model', 'text-davinci-002',
    'openai-organization', 'kill-9',
    'openai-processing-ms', '442',
    'openai-version', '2020-10-01',
    'x-ratelimit-limit-requests', '3000',
    'x-ratelimit-limit-tokens', '250000',
    'x-ratelimit-remaining-requests', '2999',
    'x-ratelimit-remaining-tokens', '249984',
    'x-ratelimit-reset-requests', '20ms',
    'x-ratelimit-reset-tokens', '3ms',
    'x-request-id', '7df89d8afe7bf24dc04e2c4dd4962d7f'
  ])

const llm = new OpenAI({
  apiKey: '<not-a-real-key>'
})

const parser = new StringOutputParser()

const chain = llm.pipe(parser)

await chain.invoke('a test')
