import { OpenAI } from '@langchain/openai'
import { StringOutputParser } from '@langchain/core/output_parsers'

const llm = new OpenAI({
  apiKey: '<not-a-real-key>',
  configuration: {
    baseURL: 'http://127.0.0.1:9126/vcr/openai'
  },
  model: 'gpt-3.5-turbo-instruct'
})

const parser = new StringOutputParser()

const chain = llm.pipe(parser)

await chain.invoke('what is 2 + 2?')
