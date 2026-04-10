'use strict'

const { describe, before, it } = require('mocha')
const { tracingChannel, channel } = require('dc-polyfill')

const {
  useLlmObs,
  assertLlmObsSpanEvent,
} = require('../../util')

// Use tracingChannel to match the shimmer's channel contract.
const sessionCh = tracingChannel('apm:claude-agent-sdk:session')
const turnCh = tracingChannel('apm:claude-agent-sdk:turn')
const toolCh = tracingChannel('apm:claude-agent-sdk:tool')
const subagentCh = tracingChannel('apm:claude-agent-sdk:subagent')

describe('Plugin', () => {
  const { getEvents } = useLlmObs({ plugin: 'claude-agent-sdk' })

  // The Claude Agent SDK is pure ESM and can't be CJS-required in tests.
  // Simulate the module load event so the plugin manager activates the
  // plugin's channel subscriptions (same event register.js publishes
  // when a real SDK module is loaded and version-matched).
  before(() => {
    const loadCh = channel('dd-trace:instrumentation:load')
    loadCh.publish({ name: '@anthropic-ai/claude-agent-sdk' })
  })

  describe('claude-agent-sdk', () => {
    describe('session', () => {
      it('creates an agent span with spec-aligned metadata', async () => {
        const ctx = {
          prompt: 'Fix the bug in auth.py',
          model: 'anthropic/claude-opus-4-6',
          sessionId: 'sess-001',
          permissionMode: 'default',
          source: 'startup',
          cwd: '/home/user/project',
          agentType: 'main',
          transcriptPath: '/tmp/transcript.jsonl',
        }

        sessionCh.start.runStores(ctx, () => {
          sessionCh.end.publish(ctx)
        })

        ctx.endReason = 'completed'
        ctx.lastAssistantMessage = 'Fixed the auth bug.'
        sessionCh.asyncEnd.publish(ctx)

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'agent',
          name: 'session',
          inputValue: 'Fix the bug in auth.py',
          outputValue: 'Fixed the auth bug.',
          metadata: {
            session_id: 'sess-001',
            model_name: 'claude-opus-4-6',
            model_provider: 'anthropic',
            start_trigger: 'fresh',
            permission_mode: 'default',
            project_dir: '/home/user/project',
            agent_type: 'main',
            exit_reason: 'completed',
            transcript_path: '/tmp/transcript.jsonl',
          },
          tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
        })
      })

      it('splits model name from provider prefix', async () => {
        const ctx = {
          prompt: 'Hello',
          model: 'anthropic/claude-sonnet-4-6',
          sessionId: 'sess-model-split',
        }

        sessionCh.start.runStores(ctx, () => {
          sessionCh.end.publish(ctx)
        })
        sessionCh.asyncEnd.publish(ctx)

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'agent',
          name: 'session',
          inputValue: 'Hello',
          outputValue: '',
          metadata: {
            session_id: 'sess-model-split',
            model_name: 'claude-sonnet-4-6',
            model_provider: 'anthropic',
          },
          tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
        })
      })

      it('handles model without provider prefix', async () => {
        const ctx = {
          prompt: 'Hello',
          model: 'claude-opus-4-6',
          sessionId: 'sess-no-prefix',
        }

        sessionCh.start.runStores(ctx, () => {
          sessionCh.end.publish(ctx)
        })
        sessionCh.asyncEnd.publish(ctx)

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'agent',
          name: 'session',
          inputValue: 'Hello',
          outputValue: '',
          metadata: {
            session_id: 'sess-no-prefix',
            model_name: 'claude-opus-4-6',
            model_provider: 'anthropic',
          },
          tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
        })
      })

      it('creates a session span without model', async () => {
        const ctx = {
          prompt: 'Hello',
          sessionId: 'sess-no-model',
        }

        sessionCh.start.runStores(ctx, () => {
          sessionCh.end.publish(ctx)
        })
        sessionCh.asyncEnd.publish(ctx)

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'agent',
          name: 'session',
          inputValue: 'Hello',
          outputValue: '',
          metadata: {
            session_id: 'sess-no-model',
          },
          tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
        })
      })
    })

    describe('turn', () => {
      it('creates an agent span (not workflow) with turn output', async () => {
        const ctx = {
          sessionId: 'sess-001',
          prompt: 'List all files',
        }

        turnCh.start.runStores(ctx, () => {
          turnCh.end.publish(ctx)
        })

        ctx.stopReason = 'end_turn'
        ctx.lastAssistantMessage = 'Here are the files in the directory...'
        turnCh.asyncEnd.publish(ctx)

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'agent',
          name: 'turn',
          inputValue: 'List all files',
          outputValue: 'Here are the files in the directory...',
          metadata: {
            session_id: 'sess-001',
          },
          tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
        })
      })

      it('falls back to stopReason when lastAssistantMessage is absent', async () => {
        const ctx = {
          sessionId: 'sess-001',
          prompt: 'Do something',
        }

        turnCh.start.runStores(ctx, () => {
          turnCh.end.publish(ctx)
        })

        ctx.stopReason = 'end_turn'
        turnCh.asyncEnd.publish(ctx)

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'agent',
          name: 'turn',
          inputValue: 'Do something',
          outputValue: 'end_turn',
          metadata: {
            session_id: 'sess-001',
          },
          tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
        })
      })
    })

    describe('tool', () => {
      it('creates a tool span with dynamic name', async () => {
        const ctx = {
          sessionId: 'sess-001',
          toolName: 'Read',
          toolInput: { file_path: '/tmp/test.txt' },
          toolUseId: 'tu-001',
        }

        toolCh.start.runStores(ctx, () => {
          toolCh.end.publish(ctx)
        })

        ctx.toolResponse = 'Hello from the file'
        toolCh.asyncEnd.publish(ctx)

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'tool',
          name: 'Read',
          inputValue: '{"file_path":"/tmp/test.txt"}',
          outputValue: 'Hello from the file',
          metadata: {
            tool_name: 'Read',
            tool_use_id: 'tu-001',
            session_id: 'sess-001',
          },
          tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
        })
      })

      it('creates a tool span with string input', async () => {
        const ctx = {
          sessionId: 'sess-001',
          toolName: 'Bash',
          toolInput: 'echo hello',
          toolUseId: 'tu-string',
        }

        toolCh.start.runStores(ctx, () => {
          toolCh.end.publish(ctx)
        })

        ctx.toolResponse = 'hello'
        toolCh.asyncEnd.publish(ctx)

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'tool',
          name: 'Bash',
          inputValue: 'echo hello',
          outputValue: 'hello',
          metadata: {
            tool_name: 'Bash',
            tool_use_id: 'tu-string',
            session_id: 'sess-001',
          },
          tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
        })
      })

      it('falls back to "tool" when toolName is missing', async () => {
        const ctx = {
          sessionId: 'sess-001',
          toolUseId: 'tu-noname',
          toolInput: { key: 'value' },
        }

        toolCh.start.runStores(ctx, () => {
          toolCh.end.publish(ctx)
        })

        ctx.toolResponse = 'result'
        toolCh.asyncEnd.publish(ctx)

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'tool',
          name: 'tool',
          inputValue: '{"key":"value"}',
          outputValue: 'result',
          metadata: {
            tool_use_id: 'tu-noname',
            session_id: 'sess-001',
          },
          tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
        })
      })

      it('handles unserializable input via safeStringify', async () => {
        const circular = {}
        circular.self = circular

        const ctx = {
          sessionId: 'sess-001',
          toolName: 'Circular',
          toolInput: circular,
          toolUseId: 'tu-circular',
        }

        toolCh.start.runStores(ctx, () => {
          toolCh.end.publish(ctx)
        })

        ctx.toolResponse = 'done'
        toolCh.asyncEnd.publish(ctx)

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'tool',
          name: 'Circular',
          inputValue: '[unserializable]',
          outputValue: 'done',
          metadata: {
            tool_name: 'Circular',
            tool_use_id: 'tu-circular',
            session_id: 'sess-001',
          },
          tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
        })
      })

      it('outputs error message on tool failure', async () => {
        const ctx = {
          sessionId: 'sess-001',
          toolName: 'Bash',
          toolInput: { command: 'false' },
          toolUseId: 'tu-fail',
        }

        toolCh.start.runStores(ctx, () => {
          toolCh.end.publish(ctx)
        })

        ctx.error = 'command failed with exit code 1'
        ctx.isInterrupt = true
        toolCh.asyncEnd.publish(ctx)

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'tool',
          name: 'Bash',
          inputValue: '{"command":"false"}',
          outputValue: 'command failed with exit code 1',
          metadata: {
            tool_name: 'Bash',
            tool_use_id: 'tu-fail',
            session_id: 'sess-001',
            is_interrupt: true,
          },
          tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
        })
      })
    })

    describe('subagent', () => {
      it('creates an agent span with dynamic name', async () => {
        const ctx = {
          sessionId: 'sess-001',
          agentId: 'agent-abc',
          agentType: 'code-reviewer',
        }

        subagentCh.start.runStores(ctx, () => {
          subagentCh.end.publish(ctx)
        })

        ctx.transcriptPath = '/tmp/agent-abc-transcript.json'
        ctx.lastAssistantMessage = 'Review complete. No issues found.'
        subagentCh.asyncEnd.publish(ctx)

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'agent',
          name: 'subagent-code-reviewer',
          inputValue: 'code-reviewer',
          outputValue: 'Review complete. No issues found.',
          metadata: {
            agent_id: 'agent-abc',
            agent_type: 'code-reviewer',
            session_id: 'sess-001',
            agent_transcript_path: '/tmp/agent-abc-transcript.json',
          },
          tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
        })
      })

      it('creates a subagent span with minimal fields', async () => {
        const ctx = {
          sessionId: 'sess-001',
          agentId: 'agent-minimal',
        }

        subagentCh.start.runStores(ctx, () => {
          subagentCh.end.publish(ctx)
        })
        subagentCh.asyncEnd.publish(ctx)

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'agent',
          name: 'subagent',
          inputValue: 'agent-minimal',
          outputValue: '',
          metadata: {
            agent_id: 'agent-minimal',
            session_id: 'sess-001',
          },
          tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
        })
      })
    })
  })
})
