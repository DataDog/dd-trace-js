# Step 20: write_tests

- Type: agent
- Objective: Generate LLM observability tests for an integration.
- Relevant skills: llmobs-testing

## Prompt

<!-- Workflow: llmobs, Namespace: genkit, Step: write_tests -->

# LLM Observability Test Implementation

## ⚠️ CRITICAL REQUIREMENT: CATEGORY-BASED TEST STRATEGY ⚠️

**PACKAGE CATEGORY: <derive from repository or prior step: package_category>**

**THIS IS NON-NEGOTIABLE. YOU MUST FOLLOW THE CATEGORY-SPECIFIC TEST STRATEGY.**

### CATEGORY RULES (BLOCKING REQUIREMENT):

**IF category = "orchestration" (THIS PACKAGE):**
- ❌ **FORBIDDEN:** VCR cassettes, VCR proxy URLs, Client classes, HTTP baseURL configuration
- ❌ **FORBIDDEN:** Real API calls to LLM providers
- ✅ **REQUIRED:** Pure function tests using StateGraph/workflow APIs directly
- ✅ **REQUIRED:** spanKind must be 'workflow' or 'agent', NOT 'llm'
- ✅ **REQUIRED:** Test the orchestration library's own methods (invoke, stream, run)

**IF category = "llm_client" or "multi_provider":**
- ✅ **REQUIRED:** VCR cassettes with proxy baseURL
- ✅ **REQUIRED:** spanKind must be 'llm'
- ✅ **REQUIRED:** Test client API methods (chat, completion, generate)

**IF category = "tool_client":**
- ✅ **REQUIRED:** Mock server tests for protocol endpoints
- ✅ **REQUIRED:** spanKind must be 'tool' or 'retrieval', NOT 'llm'
- ✅ **REQUIRED:** Test tool execution and resource retrieval methods
- ✅ **REQUIRED:** Validate protocol-specific metadata (tool names, resource URIs)
- ❌ **FORBIDDEN:** VCR cassettes (protocol clients need mock servers)

**IF category = "infrastructure":**
- ✅ **REQUIRED:** Mock server tests
- ❌ **FORBIDDEN:** VCR cassettes
- ⚠️ **NOTE:** Infrastructure packages may not need LLMObs tests if they have no LLM operations

**VALIDATION CHECKPOINT:**
Before writing any code, state which category this package is and which strategy you will use.
If you proceed with the wrong strategy, this task will fail and you will need to start over.

---

## Skills Required

**CRITICAL: Load this skill immediately:**

```
/skill llmobs-testing
```

The skill provides category-specific strategies. **Read the ORCHESTRATION section carefully if category = "orchestration".**

---

## Context

**Integration:** genkit
**Plugin Directory:** <derive from repository or prior step: plugin_dir>
**Methods to Test:** <derive from repository or prior step: methods_to_test>
**Test File:** <derive from repository or prior step: test_file_path>
**Cassette Directory:** <derive from repository or prior step: cassette_dir>
**Package Category:** <derive from repository or prior step: package_category> ← THIS DETERMINES YOUR ENTIRE APPROACH

---

## MANDATORY: Category Strategy Lookup

**STOP. Before proceeding, consult the llmobs-testing skill for <derive from repository or prior step: package_category> strategy.**

The skill contains specific instructions for <derive from repository or prior step: package_category>. You MUST follow them exactly.

---

## Your Task

### 1. DECLARE CATEGORY AND STRATEGY (MANDATORY FIRST STEP)

**Before writing ANY code, you MUST explicitly state:**

```
Package Category: <derive from repository or prior step: package_category>
Test Strategy: [describe the strategy you will use based on the category]
Forbidden Patterns: [list what you will NOT do based on the category]
Required Patterns: [list what you WILL do based on the category]
```

**This declaration is mandatory. If you skip this, the test will be rejected.**

### 2. Study Category-Appropriate Examples

Refer to the llmobs-testing skill for **<derive from repository or prior step: package_category>-specific examples**.

The skill lists which test files to study and which patterns to use for your category. Only study examples from your category — do not read examples from other categories as they will mislead you.

### 3. Verify Strategy Alignment (VALIDATION CHECKPOINT)

**Before writing the test file, verify:**

- [ ] I have read the llmobs-testing skill for <derive from repository or prior step: package_category>
- [ ] I understand which patterns are FORBIDDEN for <derive from repository or prior step: package_category>
- [ ] I understand which patterns are REQUIRED for <derive from repository or prior step: package_category>
- [ ] I have studied examples from <derive from repository or prior step: package_category> ONLY (not other categories)
- [ ] I can describe the test structure I will create without looking at wrong examples

### 4. Write Test File (Following Category Strategy)

Create test at <derive from repository or prior step: test_file_path>.

**CATEGORY-SPECIFIC IMPLEMENTATION:**

Refer to the llmobs-testing skill for **<derive from repository or prior step: package_category>** implementation patterns, mandatory structure, and validation checklists.

### 5. Self-Validate Before Submitting (FINAL CHECKPOINT)

**Run through this checklist. If any item fails, rewrite the test:**

**Category Compliance:**
- [ ] My test strategy matches <derive from repository or prior step: package_category> (not other categories)
- [ ] I have NOT used forbidden patterns for <derive from repository or prior step: package_category>
- [ ] I have used all required patterns for <derive from repository or prior step: package_category>

**Technical Compliance:**
- [ ] Correct imports (useLlmObs, assertLlmObsSpanEvent, MOCK_*)
- [ ] Correct spanKind for <derive from repository or prior step: package_category>
- [ ] All methods in <derive from repository or prior step: methods_to_test> are covered
- [ ] No mixing of patterns from different categories

---

## ❌ FATAL ERRORS (These Will Cause Immediate Test Failure) ❌

**ORCHESTRATION category violations (<derive from repository or prior step: package_category> = "orchestration"):**
- ❌ **FATAL:** Using `new Client()` - orchestration libraries don't have Client classes
- ❌ **FATAL:** Configuring VCR proxy baseURL (`httpOptions: { baseUrl: '...' }`)
- ❌ **FATAL:** Using spanKind: 'llm' - orchestration spans are 'workflow' or 'agent'
- ❌ **FATAL:** Reading examples from openai/google-genai tests (wrong category)
- ❌ **FATAL:** Adding modelName/modelProvider fields (orchestration isn't LLM API)

**LLM_CLIENT category violations:**
- ❌ **FATAL:** NOT using VCR proxy when category is llm_client
- ❌ **FATAL:** Using spanKind: 'workflow' when testing chat API

**ALL categories:**
- ❌ **FATAL:** Using patterns from wrong category examples
- ❌ **FATAL:** Ignoring category-specific instructions from llmobs-testing skill

**IF YOU MAKE ANY OF THESE MISTAKES, THE TEST WILL FAIL AND YOU WILL NEED TO COMPLETELY REWRITE IT.**

---

## Success Criteria (ALL Must Be True)

- [ ] Category strategy declaration completed (step 1)
- [ ] Validation checkpoints passed (steps 2, 3, 5)
- [ ] Test file uses ONLY patterns appropriate for <derive from repository or prior step: package_category>
- [ ] No forbidden patterns from <derive from repository or prior step: package_category> appear in code
- [ ] All required patterns from <derive from repository or prior step: package_category> are present
- [ ] spanKind matches category (orchestration→workflow, llm_client→llm)
- [ ] Examples studied were from <derive from repository or prior step: package_category> only (not other categories)

**If ANY criterion is false, the test is incorrect and will be rejected.**

---

## Final Reminder

**The category <derive from repository or prior step: package_category> is the single most important piece of information.**

Everything else (test structure, assertions, setup) follows from the category.

**If you use patterns from the wrong category, the test will fail no matter how well-written it is.**

**Read the llmobs-testing skill. Follow it exactly. Do not improvise.**


## Expected Output Format

Output must be valid JSON matching this format:

```typescript
{
  success?: boolean,
  test_file_path: string,  // Path to generated/updated test file
  methods_covered?: string[],  // Methods covered by tests
  cassettes_created?: string[],  // Cassette files created/referenced
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
