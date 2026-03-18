# VCR Cassettes Guide

Using VCR for recording and replaying API calls in LLMObs tests.

## What is VCR?

VCR (Video Cassette Recorder) records real HTTP requests/responses and replays them in tests.

**Benefits:**
- Tests use real API responses (authentic data)
- No API keys needed in CI
- Deterministic test execution
- No external dependencies after recording

## How VCR Works

1. **Recording:** First test run makes real API calls through VCR proxy
2. **Proxy captures:** HTTP requests/responses saved to cassette files (YAML)
3. **Playback:** Subsequent runs replay from cassettes (no real API calls)

## VCR Configuration

Configure client to use VCR proxy:

```javascript
const client = new MyLLMClient({
  apiKey: process.env.PROVIDER_API_KEY ?? 'test-api-key',  // Real key needed for first recording; replays work without one
  baseURL: 'http://127.0.0.1:9126/vcr/{provider-name}'  // VCR proxy URL
})
```

**URL Format:** `http://127.0.0.1:9126/vcr/{provider-name}`

**Examples:**
- OpenAI: `http://127.0.0.1:9126/vcr/openai`
- Anthropic: `http://127.0.0.1:9126/vcr/anthropic`
- Google: `http://127.0.0.1:9126/vcr/google-genai`

## Recording Process

### Step 1: Set Real API Key

```bash
export OPENAI_API_KEY="your-real-key"
export ANTHROPIC_API_KEY="your-real-key"
```

### Step 2: Run Tests

```bash
npm test packages/dd-trace/test/llmobs/plugins/my-provider/
```

### Step 3: VCR Auto-Generates Cassettes

Cassettes saved to: `test/llmobs/plugins/{provider}/cassettes/`

### Step 4: Commit Cassettes

```bash
git add packages/dd-trace/test/llmobs/plugins/my-provider/cassettes/
git commit -m "Add VCR cassettes for my-provider"
```

## Cassette Directory Structure

```
packages/dd-trace/test/llmobs/plugins/
├── openai/
│   ├── index.spec.js
│   └── cassettes/
│       ├── chat-completion.yaml
│       ├── chat-streaming.yaml
│       └── embeddings.yaml
├── anthropic/
│   ├── index.spec.js
│   └── cassettes/
│       ├── messages-create.yaml
│       └── messages-streaming.yaml
└── google-genai/
    ├── index.spec.js
    └── cassettes/
        └── generate-content.yaml
```

## Cassette Format

Cassettes are YAML files with request/response data:

```yaml
interactions:
  - request:
      method: POST
      uri: https://api.openai.com/v1/chat/completions
      body:
        messages:
          - role: user
            content: Hello
    response:
      status: 200
      body:
        choices:
          - message:
              role: assistant
              content: Hi there!
```

## Re-Recording Cassettes

When to re-record:
- API response format changed
- Need to test new features
- Cassettes are outdated

**Process:**
1. Delete the specific cassette file that needs re-recording (visible in the git diff of the PR being worked on — don't delete the whole folder)
2. Set API key: `export PROVIDER_API_KEY="..."`
3. Run tests: `npm test ...`
4. Commit the updated cassette

## Playback Mode

Once cassettes exist, tests replay automatically:

- No API keys needed
- No network calls
- Fast, deterministic execution
- Works in CI without credentials

## When to Use VCR

**Use VCR for:**
- ✅ Category 1: LLM API Clients (openai, anthropic, genai)
- ✅ Category 2: Multi-Provider Frameworks (ai-sdk, langchain)

**Don't use VCR for:**
- ❌ Category 3: Pure Orchestration (langgraph, crewai)
- ❌ Category 4: Infrastructure (MCP)

## VCR Proxy Setup

VCR proxy typically runs as part of test infrastructure:

```bash
# Start VCR proxy (usually handled by test framework)
node test/vcr-proxy.js
```

Proxy listens on `http://127.0.0.1:9126` and routes to real APIs.

## Troubleshooting

### Problem: Cassettes Not Generated

**Solution:** Ensure VCR proxy is running and API key is set.

### Problem: Playback Fails

**Solution:** Check cassette format matches expected response structure.

### Problem: Tests Fail After Re-Recording

**Solution:** Response format may have changed. Update assertions to match new format.

### Problem: Missing Cassettes in CI

**Solution:** Ensure cassettes are committed to git.

## Best Practices

1. **Commit cassettes:** Always commit cassettes to version control
2. **Use descriptive names:** Name cassettes after test cases
3. **Review cassettes:** Check cassette content before committing
4. **Update when needed:** Re-record when API changes
5. **Test both modes:** Test with and without cassettes locally
6. **Clean sensitive data:** Ensure no real API keys in cassettes

## Example Test with VCR

```javascript
describe('openai LLMObs', () => {
  const { getEvents } = useLlmObs({ plugin: 'openai' })

  let openai

  beforeEach(() => {
    const OpenAI = require('openai')
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY ?? 'test-api-key',
      baseURL: 'http://127.0.0.1:9126/vcr/openai'  // VCR proxy
    })
  })

  it('instruments chat (uses VCR)', async () => {
    // First run: Records to cassette
    // Subsequent runs: Replays from cassette
    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }]
    })

    const events = getEvents()
    assertLlmObsSpanEvent(events[0], {
      spanKind: 'llm',
      modelName: 'gpt-4',
      // Response data comes from cassette
      outputMessages: [{ content: MOCK_STRING, role: 'assistant' }]
    })
  })
})
```

## VCR vs Mock Comparison

| Aspect | VCR | Manual Mocks |
|--------|-----|--------------|
| Authenticity | Real API responses | Synthetic data |
| Setup | Minimal | Requires mock implementation |
| Maintenance | Re-record when API changes | Update mock code |
| Coverage | Full response structure | Only mocked fields |
| Performance | Fast (playback) | Fast |

**Recommendation:** Use VCR for API clients (Categories 1 & 2), manual mocks for orchestration (Category 3).
