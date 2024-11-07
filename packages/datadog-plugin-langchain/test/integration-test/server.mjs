import 'dd-trace/init.js'
import { OpenAI } from '@langchain/openai'
import { StringOutputParser } from '@langchain/core/output_parsers'
import nock from 'nock'

nock('https://api.openai.com:443')
  .post('/v1/completions')
  .reply(200, {})

const llm = new OpenAI({
  apiKey: '<not-a-real-key>'
})

const parser = new StringOutputParser()

const chain = llm.pipe(parser)

await chain.invoke('a test')
