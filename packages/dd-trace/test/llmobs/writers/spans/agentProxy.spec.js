'use stict'

describe('LLMObsAgentProxySpanWriter', () => {
  let LLMObsAgentProxySpanWriter
  let writer

  beforeEach(() => {
    LLMObsAgentProxySpanWriter = require('../../../../src/llmobs/writers/spans/agentProxy')
  })

  it('is initialized correctly', () => {
    writer = new LLMObsAgentProxySpanWriter({
      hostname: '127.0.0.1',
      port: 8126
    })

    expect(writer._url.href).to.equal('http://127.0.0.1:8126/evp_proxy/v2/api/v2/llmobs')
    expect(writer._headers['X-Datadog-EVP-Subdomain']).to.equal('llmobs-intake')
  })

  it('is initialized correctly with default hostname', () => {
    writer = new LLMObsAgentProxySpanWriter({
      port: 8126 // port will always be defaulted by config
    })

    expect(writer._url.href).to.equal('http://localhost:8126/evp_proxy/v2/api/v2/llmobs')
  })

  it('uses the url property if provided on the config', () => {
    writer = new LLMObsAgentProxySpanWriter({
      url: new URL('http://test-agent:12345')
    })

    expect(writer._url.href).to.equal('http://test-agent:12345/evp_proxy/v2/api/v2/llmobs')
  })
})
