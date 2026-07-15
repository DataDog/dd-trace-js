# Task: Fix Vercel AI Tool Retention Leak (#9276)

## Source

- GitHub issue: https://github.com/DataDog/dd-trace-js/issues/9276
- This branch starts from `dd-trace-js` `origin/master` at
  `51fdd86fea6cacaec820cdac4158904bda691511`.
- Current `master` still has the reported process-lifetime strong references in
  `packages/dd-trace/src/llmobs/plugins/ai/ddTelemetry.js`:
  `#availableTools = new Set()` and `#toolCallIdsToName = {}`.
- No open pull request references #9276 as of 2026-07-15.

## Problem

Vercel AI applications commonly construct tools per request so each tool's `execute` function closes
over request-scoped state. The LLMObs AI plugin stores every full tool definition in a process-lifetime
`Set` and stores tool-call IDs in an unbounded object. Completed requests therefore remain strongly
reachable. The reporter measured approximately 11 MB retained per stream in production and a large
gap between the enabled and disabled `ai` plugin.

## Reporter Evidence

GitHub access is not required for this task. The relevant issue details are reproduced here:

- Observed with `dd-trace@5.80.0`; the reporter confirmed the code remained unchanged in
  `5.111.0` and `6.0.0`.
- Runtime: Node.js `24.16.0`, ESM application, initialized with
  `node --import dd-trace/register.js`.
- Production pattern: approximately 24 tools are created for every chat stream so each tool's
  `execute` closure can access request-scoped user, repository, and cancellation state.
- Reported impact: roughly 11 MB retained per stream, with process heap growing from about
  250 MB to the 2 GB limit during a working day.
- The retained object graphs included tool schemas, cached schema conversion data, prompt/message
  strings, and request-scoped closures.
- Workaround: set `DD_TRACE_DISABLED_PLUGINS=ai` before Node starts.

The reporter ran 30 fully consumed streams, called `global.gc()` twice, and measured retained heap:

| Configuration | Retained heap after GC |
| --- | ---: |
| `dd-trace` initialized, `ai` plugin and LLMObs active | +15.5 MB per stream |
| same process with LLMObs disabled | +12.9 MB per stream |
| `DD_TRACE_DISABLED_PLUGINS=ai` | +0.3 MB per stream |

These numbers show that the complete enabled-versus-disabled gap may not come only from the two
LLMObs registries. The diagnosis must isolate how much retention each registry causes and must not
claim that all AI SDK retention is fixed unless the measurements prove it.

The issue's reproduction shape is:

```js
import 'dd-trace/init.js'
import { tool, streamText } from 'ai'
import { z } from 'zod'

function createTools (requestContext) {
  return {
    my_tool: tool({
      description: 'does things',
      inputSchema: z.object({
        q: z.string(),
        filters: z.array(z.object({ k: z.string(), v: z.string() })),
      }),
      execute: async () => ({ ok: true, userId: requestContext.userId }),
    }),
  }
}

for (let i = 0; i < 1000; i++) {
  const requestContext = {
    userId: String(i),
    bigBuffer: 'x'.repeat(1e6),
  }
  const result = streamText({
    model,
    tools: createTools(requestContext),
    prompt: 'hi',
  })
  for await (const chunk of result.textStream) {
    void chunk
  }
}
```

Adapt this into a deterministic repository-local reproduction with a fake or recorded model so the
measurement does not depend on live model variability. Preserve the per-request closure and fully
consume each stream. Record exact heap samples and slopes, not only a prose conclusion.

## Goal

Remove unbounded strong retention of tool objects and tool-call IDs while preserving correct tool-name
resolution and LLMObs tool spans across every supported Vercel AI SDK path that uses this registry.
Choose the smallest lifecycle-safe design after reproducing the leak; do not assume the issue's proposed
`WeakRef`, bounded cache, or cleanup strategy is automatically correct.

## Required Workflow

1. Delegate a read-only diagnosis to a focused subagent. It must inspect issue #9276, the commit/PR that
   introduced the registries, all writers/readers, plugin lifecycle, supported AI SDK versions, and tests.
2. Build a deterministic reproduction before editing production code. Use per-request tools that retain a
   distinguishable large closure, fully consume each stream, force GC with `node --expose-gc`, and measure
   retained heap as completed-request count increases. Include a plugin-disabled control.
3. Have an implementation subagent apply the smallest fix justified by the diagnosis. Avoid a generic cache
   framework, unrelated refactors, or weakened tool-name behavior.
4. Have separate focused subagents run test diagnosis/fixes and adversarial review. The main agent coordinates,
   reviews diffs, records receipts, and enforces the final gates.
5. Re-run the exact reproduction after the fix. Compare the retained-heap slope and object reachability to the
   baseline; a single end-state heap number is insufficient.
6. Run a real tool-calling sample and capture actual APM and LLMObs spans. Verify resolved tool name,
   arguments/result, hierarchy, completion/error behavior, and duplicate-span count.

## Scope

Expected scope is limited to the Vercel AI instrumentation/LLMObs implementation and focused tests, primarily:

- `packages/dd-trace/src/llmobs/plugins/ai/ddTelemetry.js`
- `packages/dd-trace/test/llmobs/plugins/ai/index.spec.js`
- `packages/datadog-plugin-ai/test/` only if instrumentation-level coverage is required

The issue concerns registry lifetime, not AI SDK version support. Do not update unrelated dependencies,
restructure the complete plugin, modify other LLM integrations, or add committed evidence artifacts.

## Acceptance Gates

- The unmodified branch reproduces retained heap that scales with completed requests.
- After the fix, the same reproduction demonstrates that completed per-request tools and tool-call IDs are
  reclaimable or otherwise bounded; retained heap no longer grows proportionally with request count.
- Tool-name fallback behavior still works for supported SDK versions, including ambiguous/numeric tool names.
- Targeted AI plugin and LLMObs tests pass, followed by build and lint from one unchanged source revision.
- Captured APM and LLMObs traces show correct tool names, input/output, hierarchy, errors, and no duplicates.
- A separate review subagent finds no new global retention, race, cross-request name collision, or lifecycle bug.
- Bounded summaries contain commands, revisions, measurements, artifact hashes, and expected/observed results.
  Raw heap profiles, logs, and trace JSON remain under gitignored `.dd-apm-pipeline/evidence/*/raw/`.

## Stop Conditions

- Do not change production code before recording a baseline reproduction.
- If the reproduction cannot distinguish the plugin from the disabled control, stop and revise it.
- If memory or trace capture infrastructure is unavailable, mark the relevant final gate BLOCKED.
- Do not open a PR with failed, blocked, stale, or unreviewed gates.
