'use stict'

describe('LLMObsAgentlessSpanWriter', () => {
  let LLMObsAgentlessSpanWriter
  let writer

  beforeEach(() => {
    LLMObsAgentlessSpanWriter = require('../../../../src/llmobs/writers/spans/agentless')
  })

  it('is initialized correctly', () => {
    writer = new LLMObsAgentlessSpanWriter({
      site: 'datadoghq.com',
      llmobs: {
        apiKey: 'test'
      },
      apiKey: '1234'
    })

    expect(writer._url.href).to.equal('https://llmobs-intake.datadoghq.com/api/v2/llmobs')
    expect(writer._headers['DD-API-KEY']).to.equal('test')
  })

  it('uses the default api key if none is provided on llmobs', () => {
    writer = new LLMObsAgentlessSpanWriter({
      site: 'datadoghq.com',
      apiKey: '1234'
    })

    expect(writer._headers['DD-API-KEY']).to.equal('1234')
  })
})
