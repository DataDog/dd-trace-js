# LangGraph LLMObs Test Cassettes

This directory is reserved for VCR cassettes if tests require recording external API calls.

## Current Test Coverage

The current langgraph LLMObs tests focus on workflow orchestration without external API calls, using simple state transformations. Therefore, no cassettes are currently needed.

## Adding Tests with API Calls

If you want to add tests that involve LangGraph workflows calling external LLM APIs (e.g., OpenAI, Anthropic), you would:

1. Configure the LLM client to use the VCR proxy: `http://127.0.0.1:9126/vcr/<provider>`
2. Create cassette YAML files in this directory with the recorded interactions
3. Reference the cassettes in your test setup

Example cassette structure:
```yaml
version: 1
interactions:
  - request:
      uri: https://api.openai.com/v1/chat/completions
      method: POST
      body: '{"model":"gpt-4","messages":[...]}'
    response:
      status: 200
      body: '{"choices":[{"message":{"content":"..."}}]}'
```

## See Also

- `/packages/dd-trace/test/llmobs/plugins/langchain/` for examples of tests with cassettes
- LangGraph documentation: https://langchain-ai.github.io/langgraph/
