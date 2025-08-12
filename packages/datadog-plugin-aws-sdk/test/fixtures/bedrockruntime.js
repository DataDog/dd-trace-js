'use strict'

const bedrockruntime = {}

const PROVIDER = {
  AI21: 'AI21',
  AMAZON: 'AMAZON',
  ANTHROPIC: 'ANTHROPIC',
  COHERE: 'COHERE',
  META: 'META',
  MISTRAL: 'MISTRAL'
}

const prompt = 'What is the capital of France?'
const temperature = 0.5
const topP = 1
const topK = 1
const maxTokens = 512

bedrockruntime.models = [
  {
    provider: PROVIDER.AMAZON,
    modelId: 'amazon.titan-text-lite-v1',
    userPrompt: prompt,
    requestBody: {
      inputText: prompt,
      textGenerationConfig: {
        temperature,
        topP,
        maxTokenCount: maxTokens
      }
    },
    response: {
      inputTextTokenCount: 7,
      results: [{
        tokenCount: 35,
        outputText: '\n' +
            'Paris is the capital of France. France is a country that is located in Western Europe. ' +
            'Paris is one of the most populous cities in the European Union. ',
        completionReason: 'FINISH'
      }]
    },
    usage: {
      inputTokens: 7,
      outputTokens: 35,
      totalTokens: 42
    },
    output: '\n' +
      'Paris is the capital of France. France is a country that is located in Western Europe. ' +
      'Paris is one of the most populous cities in the European Union. '
  },
  {
    provider: PROVIDER.AI21,
    modelId: 'ai21.jamba-1-5-mini-v1',
    userPrompt: prompt,
    requestBody: {
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: maxTokens,
      temperature,
      top_p: topP,
      top_k: topK
    },
    response: {
      id: 'req_0987654321',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'The capital of France is Paris.'
          },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 7,
        total_tokens: 17
      }
    },
    usage: {
      inputTokens: 10,
      outputTokens: 7,
      totalTokens: 17
    },
    output: 'The capital of France is Paris.',
    outputRole: 'assistant'
  },
  {
    provider: PROVIDER.ANTHROPIC,
    modelId: 'anthropic.claude-v2',
    userPrompt: `\n\nHuman:${prompt}\n\nAssistant:`,
    requestBody: {
      prompt: `\n\nHuman:${prompt}\n\nAssistant:`,
      temperature,
      top_p: topP,
      top_k: topK,
      max_tokens_to_sample: maxTokens
    },
    response: {
      type: 'completion',
      completion: ' Paris is the capital of France.',
      stop_reason: 'stop_sequence',
      stop: '\n\nHuman:'
    },
    output: ' Paris is the capital of France.'
  },
  {
    provider: PROVIDER.COHERE,
    modelId: 'cohere.command-light-text-v14',
    userPrompt: prompt,
    requestBody: {
      prompt,
      temperature,
      p: topP,
      k: topK,
      max_tokens: maxTokens
    },
    response: {
      id: '91c65da4-e2cd-4930-a4a9-f5c68c8a137c',
      generations: [
        {
          id: 'c040d384-ad9c-4d15-8c2f-f36fbfb0eb55',
          text: ' The capital of France is Paris. \n',
          finish_reason: 'COMPLETE'
        }
      ],
      prompt: 'What is the capital of France?'
    },
    output: ' The capital of France is Paris. \n'
  },
  {
    provider: PROVIDER.META,
    modelId: 'meta.llama3-70b-instruct-v1',
    userPrompt: prompt,
    requestBody: {
      prompt,
      temperature,
      top_p: topP,
      max_gen_len: maxTokens
    },
    response: {
      generation: '\n\nThe capital of France is Paris.',
      prompt_token_count: 10,
      generation_token_count: 7,
      stop_reason: 'stop'
    },
    usage: {
      inputTokens: 10,
      outputTokens: 7,
      totalTokens: 17
    },
    output: '\n\nThe capital of France is Paris.'
  },
  {
    provider: PROVIDER.MISTRAL,
    modelId: 'mistral.mistral-7b-instruct-v0',
    userPrompt: prompt,
    requestBody: {
      prompt,
      max_tokens: maxTokens,
      temperature,
      top_p: topP,
      top_k: topK
    },
    response: {
      outputs: [
        {
          text: 'The capital of France is Paris.',
          stop_reason: 'stop'
        }
      ]
    },
    output: 'The capital of France is Paris.'
  }
]
bedrockruntime.modelConfig = {
  temperature,
  topP,
  topK,
  maxTokens
}

module.exports = bedrockruntime
