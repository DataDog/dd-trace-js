'use strict'

const BaseAwsSdkPlugin = require('../../base')

class BedrockAgentRuntime extends BaseAwsSdkPlugin {
  static id = 'bedrockagentruntime'

  generateTags (params, operation) {
    const tags = { 'resource.name': operation }
    if (params?.agentId) tags['aws.bedrock.agent.id'] = params.agentId
    if (params?.agentAliasId) tags['aws.bedrock.agent.alias_id'] = params.agentAliasId
    if (params?.sessionId) tags['aws.bedrock.session_id'] = params.sessionId
    return tags
  }
}

module.exports = BedrockAgentRuntime
