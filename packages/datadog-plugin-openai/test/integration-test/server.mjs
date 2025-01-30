import 'dd-trace/init.js'
import openai from 'openai'
import nock from 'nock'

nock('https://api.openai.com:443')
  .post('/v1/completions')
  .reply(200, {})

const openaiApp = new openai.OpenAIApi(new openai.Configuration({
  apiKey: 'sk-DATADOG-ACCEPTANCE-TESTS'
}))

await openaiApp.createCompletion({
  model: 'text-davinci-002',
  prompt: 'Hello, ',
  suffix: 'foo',
  stream: true
})
