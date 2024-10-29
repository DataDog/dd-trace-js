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
      llmobs: {},
      apiKey: '1234'
    })

    expect(writer._url.href).to.equal('https://llmobs-intake.datadoghq.com/api/v2/llmobs')
    expect(writer._headers['DD-API-KEY']).to.equal('1234')
  })
})
