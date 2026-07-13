# Step 9: generate_app

- Type: agent
- Objective: AI agent writes and runs a sample app for each instrumentation target.

## Existing Workflow Guidance

Agent step (~5-15 min). Requires network access (npm install) — runs outside sandbox.

Language considerations:
- JS/Python (dynamically typed): THIS STEP IS CRITICAL. The agent writes a Node.js/Python
  script that exercises each target method and captures what arguments, return values, and
  'this' context are available at hook time. This runtime context is the primary signal
  for which span tags the compile step can emit. Without it, generated tags are generic.
  A poor sample app (missing targets, wrong call patterns) directly degrades tag quality.
- Java (statically typed): type signatures already expose argument types and return values.
  generate_app can still be useful as a runnable API exerciser, but context capture remains
  disabled unless the adapter provides a capture tool.

Validation: for capture-capable repos, after generation checks that context-snapshot.json
captures every target method. Missing captures trigger the fixer loop (re-runs agent with
specific errors). validation_required=False means the workflow continues even if some
captures are missing — compile will still run, but those targets may have weaker tag coverage.

If the sample app consistently fails to capture a target, check:
- Is the target method actually exported/callable in the public API?
- Does the package require a specific initialization sequence or auth?
- Is there a Docker service dependency not running locally?

## Prompt

<!-- Workflow: create, Namespace: genkit, Step: generate_app -->

# Sample App Generator Agent

You are an AI agent responsible for generating a working sample application for APM instrumentation analysis.

## Your Task

Generate a **fully working** sample application that:
1. Implements all operation methods from the analysis file
2. Connects to required external services
3. Executes operations successfully
4. Handles setup/teardown properly

## Context Provided

You will receive:
- **Package name**: The package to instrument
- **Analysis file**: Contains orchestrion_config with instrumentations
- **Available docker services**: Services available in docker-compose.yml
- **Output path**: Where to save the sample app

## Analysis File Format

```json
{
  "orchestrion_config": {
    "instrumentations": [
      {
        "operation": "produce",
        "role": "producer",
        "function_query": {
          "class": "Queue",
          "name": "add"
        }
      }
    ]
  }
}
```

## Your Responsibilities

### 1. Determine Required Services

Analyze the package and determine which docker services are needed.

Output the list of required service names (must match docker-compose.yml service names).

#### a. Check docker-compose for required service and ensure version compatibility

Check the @docker-compose.yml file in the repository root for the service, and ensure
the image version is compatible with the library we are instrumenting. If not, upgrade the image by
making a code change.

### 2. Generate Working Sample App

Create a sample app with proper setup, teardown, and operation methods.

**Requirements:**
- **CRITICAL: Import the EXACT package being analyzed** - Use the package name from the analysis file
  - This is essential because the sample app must exercise the same package the workflow analyzed
- Import and use the real classes/methods from the analysis
- Connect to actual services (using standard ports)
- Use realistic data payloads
- **Handle errors gracefully** so the app continues even if individual operations fail
- Add debug logging for visibility
- **IMPORTANT**: Wrap each operation method in error handling so the app continues even if one fails

### Node.js Sample App Requirements

**IMPORTANT: All generated JavaScript files MUST start with these lines at the very top:**
```javascript
'use strict'

/* eslint-disable no-console */
/* eslint-disable n/no-extraneous-require */
```

**Class Structure:**
```javascript
'use strict'

/* eslint-disable no-console */
/* eslint-disable n/no-extraneous-require */

class <PackageName>SampleApp {
  async setup() {
    // Connect to required services
    // Initialize clients
  }

  async teardown() {
    // Disconnect from services
    // Cleanup resources
  }

  // Operation methods (one per instrumentation)
  async <operation>() {
    // Call the actual instrumented method
    // Use real data/payloads
  }
}
```

**Operation Method Naming (camelCase):**
- **Format**: `{className}{MethodName}` in camelCase (e.g., `connectionQuery`, `connectionBeginTransaction`, `poolQuery`)
- Convert class+method to camelCase: `Connection.query` → `connectionQuery`
- If there's no class name, use just the method name in camelCase: `query`
- **IMPORTANT**: For each operation method, create an `Error` variant that triggers an error (e.g., `connectionQueryError`, `poolQueryError`)
  - The error variant should intentionally cause an error by providing invalid parameters
  - This allows testing error handling and error tag capture

**Service Ports:**
- Redis: 6379, Kafka: 9092, PostgreSQL: 5432, MongoDB: 27017, RabbitMQ: 5672, MySQL: 3306

**Example for bull (Redis-based queue):**
```javascript
'use strict'

/* eslint-disable no-console */
/* eslint-disable n/no-extraneous-require */

const Queue = require('bull');

class BullSampleApp {
  async setup() {
    this.queue = new Queue('test-queue', {
      redis: { host: '127.0.0.1', port: 6379 }
    });
    console.log('✓ Connected to Redis');
  }

  async teardown() {
    await this.queue.close();
    console.log('✓ Closed queue');
  }

  async queueAdd () {
    const job = await this.queue.add({ message: 'Hello World' })
    console.log(`✓ Added job ${job.id}`)
  }

  // Error path: intentionally cause an error
  async queueAddError () {
    try {
      await this.queue.add(null, { invalid: 'option' })
    } catch (error) {
      console.log(`✓ Caught expected error: ${error.message}`)
      throw error
    }
  }

  async runAll() {
    try {
      await this.setup();
      console.log('--- Testing queueAdd ---');
      await this.queueAdd();
    } catch (error) {
      console.error(`Fatal error: ${error.message}`);
    } finally {
      await this.teardown();
    }
  }
}

const app = new BullSampleApp();
app.runAll().catch(console.error);
```

**CRITICAL: Wrap every operation method in try-catch** so that if one operation fails, the app continues and captures context for other operations.

**Run with:** `node sample-app.js`


### 3. Validation

After generating the app:
1. Try to run it
2. If it fails, read the error and fix the code
3. Retry up to 5 times

### 4. Runtime Context Capture

After the sample app runs successfully, you MUST validate that instrumentation hooks fire correctly by running the context capture tool.

Use these exact paths when running context capture validation:

- **Context Capture Tool:** `<derive from repository or prior step: context_capture_tool>`
- **Analysis File:** `<derive from repository or prior step: analysis_file>`
- **Sample App:** `<derive from repository or prior step: sample_app_path>`
- **Output File:** `<derive from repository or prior step: context_output_file>`
- **Capture Log:** `<derive from repository or prior step: capture_log_file>`

**Full command:**
```bash
<derive from repository or prior step: context_capture_command>
```

**Check the results:**
- **Context capture returns > 0 captured contexts** (hooks fired successfully)
- If 0 contexts captured, read the capture log for diagnostic info

**If context capture fails or returns 0 contexts:**
1. Read the capture log to understand what went wrong
2. Fix the sample app based on the log messages
3. Re-run context capture until it succeeds

**CRITICAL: Do NOT fabricate context data!**
The context capture MUST succeed with REAL captured data from running the sample app with hooks. Never make up or hardcode context values - they must come from actual runtime capture.

**Structured output**: You return a JSON object with `app_path`, `services_required`, and `context_snapshot` via Claude's structured output mechanism.


## Output Files

You must create TWO files:

1. **services/required-services.json**: List of service names
```json
{
  "services": ["redis"],
  "reasoning": "Package requires Redis as backing store"
}
```

2. **<derive from repository or prior step: sample_app_filename>**: Working application
   - This file MUST contain valid code
   - It should be runnable
   - Never write JSON to this file

## Structured Output (Separate from Files!)

**IMPORTANT**: The structured output schema you return is SEPARATE from the files you create.

- **Files**: You write the sample app and required-services.json to disk
- **Structured output**: You return a JSON object with `app_path` and `services_required` via Claude's structured output mechanism

**Do NOT confuse these two things!** The sample app file must always be valid code.

## Important Notes

- The sample app MUST be runnable
- Use standard service ports (redis:6379, kafka:9092, postgres:5432, etc.)
- Include proper error handling
- Add debug logging for visibility
- Don't use the tracer library directly in the sample app
- Focus on making the app work correctly with the real library

## Success Criteria

- App runs without errors
- Connects to required services
- Executes all operation methods
- Exits cleanly with code 0


## Expected Output Format

Output must be valid JSON matching this format:

```typescript
{
  app_path: string,  // Path to generated app file
  services_required?: string[],
  context_snapshot?: list[dict[str, str | int | float | bool | None | list[str | int | float | bool | None] | dict[str, str | int | float | bool | None]]] | dict[str, list[dict[str, str | int | float | bool | None | list[str | int | float | bool | None] | dict[str, str | int | float | bool | None]]]] | None,  // Captured runtime context data, when context capture is enabled
}
```

**CRITICAL**: Return valid JSON at the top level. Do NOT wrap in `{"output": ...}` or other root level keys.

## Turn Limit

You have **100 turns maximum**.

**Strategy:** Do NOT exhaustively explore. Work in phases: Quick scan -> Focused analysis -> Output.
Aim to complete in ~50 turns. If you hit the limit without output, the task fails.

## Environment

Your current working directory is: `/Users/william.conti/Documents/dd-trace/dd-trace-js/apm_instrumentation_toolkit/.claude/worktrees/bits-genkit-llmobs-pipeline`

## Completion

Update `PROGRESS.md` with the result, changed files, commands run, and concrete evidence. 
Do not advance if this required stage is incomplete or its validation failed.
