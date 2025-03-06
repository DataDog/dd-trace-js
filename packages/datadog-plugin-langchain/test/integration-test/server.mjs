import 'dd-trace/init.js'

import { OpenAI } from '@langchain/openai'
import { StringOutputParser } from '@langchain/core/output_parsers'
import nock from 'nock'

nock('https://api.openai.com:443')
  .post('/v1/completions')
  .reply(200, {
    model: 'gpt-3.5-turbo-instruct',
    choices: [{
      text: 'The answer is 4',
      index: 0,
      logprobs: null,
      finish_reason: 'length'
    }],
    usage: { prompt_tokens: 8, completion_tokens: 12, otal_tokens: 20 }
  })

const llm = new OpenAI({
  apiKey: '<not-a-real-key>'
})

const parser = new StringOutputParser()

const chain = llm.pipe(parser)

await chain.invoke('what is 2 + 2?')
