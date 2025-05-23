import 'dd-trace/init.js'
import OpenAI from 'openai'
import nock from 'nock'

nock('https://api.openai.com:443')
  .post('/v1/completions')
  .reply(200, {})

if (OpenAI.OpenAIApi) {
  const openaiApp = new OpenAI.OpenAIApi(new OpenAI.Configuration({
    apiKey: 'sk-DATADOG-ACCEPTANCE-TESTS'
  }))

  await openaiApp.createCompletion({
    model: 'text-davinci-002',
    prompt: 'Hello, ',
    suffix: 'foo',
    stream: true
  })
} else {
  const client = new OpenAI({
    apiKey: 'sk-DATADOG-ACCEPTANCE-TESTS'
  })

  await client.completions.create({
    model: 'text-davinci-002',
    prompt: 'Hello, ',
    suffix: 'foo',
    stream: false
  })
}
