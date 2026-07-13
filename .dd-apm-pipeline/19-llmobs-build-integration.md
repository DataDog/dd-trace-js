# Step 19: build_integration

- Type: agent
- Objective: Build LLMObs plugin using llmobs-integration skill.
- Relevant skills: llmobs-integration

## Prompt

<!-- Workflow: llmobs, Namespace: genkit, Step: build_integration -->

# LLM Observability Integration Builder

## Your Mission

Build a complete LLMObs plugin for **genkit** that instruments chat completion operations and emits proper span events.

**Handle all appropriate span kinds** based on the package category (llm, workflow, agent, tool, retrieval, embedding).

---

## Skills Required

**CRITICAL: Load this skill immediately:**

```
/skill llmobs-integration
```

The skill provides:
- LLMObsPlugin base class architecture and implementation patterns
- Package category detection (LlmObsCategory enum: LLM_CLIENT, MULTI_PROVIDER, ORCHESTRATION, INFRASTRUCTURE)
- Span kind classification (LlmObsSpanKind enum: llm, workflow, agent, tool, embedding, retrieval)
- Message extraction patterns for different providers
- Token usage and metadata extraction
- Reference implementations (OpenAI, Anthropic, Google GenAI)

**You must load this skill before generating any code.**

---

## Context

**Integration:** genkit
**Plugin Path:** <derive from repository or prior step: plugin_path>
**LLMObs Plugin Path:** <derive from repository or prior step: llmobs_plugin_path>
**Composite Plugin Path:** <derive from repository or prior step: composite_plugin_path>
**Tracing Plugin Path:** <derive from repository or prior step: tracing_plugin_path>

---

## Your Task

### 1. Detect Package Category (REQUIRED FIRST STEP)

**CRITICAL: You MUST determine the LlmObsCategory BEFORE generating any code.**

Follow the decision tree from the llmobs-integration skill to classify into one of:
- `LlmObsCategory.LLM_CLIENT` - Direct API wrappers (openai, anthropic, genai) — **LLM_CLIENT guide** - Read `references/llmobs_instrumentation/categories/llm-client.md` for detailed guidance
- `LlmObsCategory.MULTI_PROVIDER` - Multi-provider frameworks (ai-sdk, langchain) — **MULTI_PROVIDER guide** - Read `references/llmobs_instrumentation/categories/multi-provider.md` for detailed guidance
- `LlmObsCategory.ORCHESTRATION` - Workflow managers (langgraph, crewai) — **ORCHESTRATION guide** - Read `references/llmobs_instrumentation/categories/orchestration.md` for detailed guidance
- `LlmObsCategory.TOOL_CLIENT` - Protocol clients for tool execution and resource retrieval — **TOOL_CLIENT guide** - Read `references/llmobs_instrumentation/categories/tool-client.md` for detailed guidance
- `LlmObsCategory.INFRASTRUCTURE` - Supporting infrastructure without LLM operations — **INFRASTRUCTURE guide** - Read `references/llmobs_instrumentation/categories/infrastructure.md` for detailed guidance

**Output Requirements:**
- `package_category`: One of `llm_client`, `multi_provider`, `orchestration`, `tool_client`, `infrastructure`
- `category_confidence`: `high`, `medium`, or `low`
- `category_reasoning`: Explain what code patterns led to your decision (reference specific files/classes)

**Example:**
```
"Category: llm_client, Confidence: high
Reasoning: Package exports ChatClient class that directly calls the provider API.
No abstraction over multiple providers."
```

### 2. Analyze the Library API

Understand how chat completions work in this library:
- Locate chat completion methods (e.g., `chat.completions.create`, `messages.create`)
- Identify input format (messages array, prompt string, parameters)
- Identify output format (choices, content, token usage)
- Identify model parameters (temperature, max_tokens, etc.)

**For category-specific implementation guidance, refer to the linked category guide above.**

### 3. Generate LLMObs Plugin

Create the plugin at `<derive from repository or prior step: llmobs_plugin_path>` following the patterns from the llmobs-integration skill.

**Key implementation requirements:**
- Extend `LLMObsPlugin` base class
- Implement `getLLMObsSpanRegisterOptions(ctx)` - Returns model provider, name, span kind, operation name
- Implement `setLLMObsTags(ctx)` - Extracts and tags messages, metrics, metadata
- Convert messages to standard `{content, role}` format
- Handle errors with empty outputs: `[{content: '', role: ''}]`
- Extract token usage and metadata
- Export as array: `module.exports = [ProviderLLMObsPlugin]`

**Refer to the skill for:**
- Complete plugin structure template
- Provider-specific message extraction patterns
- Helper method implementations
- Reference plugin examples

---

## Success Criteria

- [ ] Package category detected using LlmObsCategory enum and documented with reasoning
- [ ] Plugin extends LLMObsPlugin base class
- [ ] Both required methods implemented (getLLMObsSpanRegisterOptions, setLLMObsTags)
- [ ] Messages converted to standard `{content, role}` format
- [ ] Token usage and metadata extracted
- [ ] Error handling with empty outputs
- [ ] Correct LlmObsSpanKind used (usually `'llm'`)
- [ ] Plugin file created at correct path and exported as array

---

## Notes

- Reference the llmobs-integration skill for all implementation patterns
- Study reference plugins (OpenAI, Anthropic, Google GenAI) in the skill's reference section
- Keep implementation simple - follow existing patterns
- Test strategy will be determined by LlmObsCategory in next step


## Expected Output Format

Output must be valid JSON matching this format:

```typescript
{
  llmobs_plugin_path: string,  // Path to created LLMObs plugin
  success?: boolean,  // Whether plugin generation succeeded
  composite_plugin_path?: string | null,  // Path to CompositePlugin (may already exist)
  files_created?: string[],  // All files created/modified
  methods_instrumented?: string[],  // Methods instrumented (e.g., chat.completions.create)
  package_category?: string,  // Package category (llm_client, multi_provider, orchestration, tool_client, infrastructure)
  error?: string | null,
}
```

**CRITICAL**: Return valid JSON at the top level. Do NOT wrap in `{"output": ...}` or other root level keys.

## Turn Limit

You have **50 turns maximum**.

**Strategy:** Do NOT exhaustively explore. Work in phases: Quick scan -> Focused analysis -> Output.
Aim to complete in ~25 turns. If you hit the limit without output, the task fails.

## Environment

Your current working directory is: `/Users/william.conti/Documents/dd-trace/dd-trace-js/apm_instrumentation_toolkit/.claude/worktrees/bits-genkit-llmobs-pipeline`

## Completion

Update `PROGRESS.md` with the result, changed files, commands run, and concrete evidence. 
Do not advance if this required stage is incomplete or its validation failed.
