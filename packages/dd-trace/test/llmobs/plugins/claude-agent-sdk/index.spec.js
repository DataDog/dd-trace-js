'use strict'

const { describe, it } = require('mocha')
const { tracingChannel } = require('dc-polyfill')

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

  describe('claude-agent-sdk', () => {
    describe('session', () => {
      it('creates an agent span with session metadata', async () => {
        const ctx = {
          prompt: 'Fix the bug in auth.py',
          model: 'claude-opus-4-6',
          sessionId: 'sess-001',
          permissionMode: 'default',
          maxTurns: 20,
        }

        sessionCh.start.runStores(ctx, () => {
          sessionCh.end.publish(ctx)
        })

        ctx.endReason = 'completed'
        ctx.source = 'startup'
        sessionCh.asyncEnd.publish(ctx)

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'agent',
          name: 'claude-agent-sdk.session',
          modelName: 'claude-opus-4-6',
          modelProvider: 'anthropic',
          inputValue: 'Fix the bug in auth.py',
          outputValue: '',
          metadata: {
            session_id: 'sess-001',
            model: 'claude-opus-4-6',
            permission_mode: 'default',
            max_turns: 20,
            source: 'startup',
            end_reason: 'completed',
          },
          tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
        })
      })

      it('tags resumed sessions with parent_session_id', async () => {
        const ctx = {
          prompt: 'Continue',
          model: 'claude-opus-4-6',
          sessionId: 'sess-002',
          resume: 'sess-001',
        }

        sessionCh.start.runStores(ctx, () => {
          sessionCh.end.publish(ctx)
        })
        sessionCh.asyncEnd.publish(ctx)

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'agent',
          name: 'claude-agent-sdk.session',
          modelName: 'claude-opus-4-6',
          modelProvider: 'anthropic',
          inputValue: 'Continue',
          outputValue: '',
          metadata: {
            session_id: 'sess-002',
            model: 'claude-opus-4-6',
            parent_session_id: 'sess-001',
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
          name: 'claude-agent-sdk.session',
          modelProvider: 'anthropic',
          inputValue: 'Hello',
          outputValue: '',
          metadata: {
            session_id: 'sess-no-model',
          },
          tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
        })
      })

      it('creates a session span with empty prompt', async () => {
        const ctx = {
          model: 'claude-opus-4-6',
          sessionId: 'sess-empty-prompt',
        }

        sessionCh.start.runStores(ctx, () => {
          sessionCh.end.publish(ctx)
        })
        sessionCh.asyncEnd.publish(ctx)

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'agent',
          name: 'claude-agent-sdk.session',
          modelName: 'claude-opus-4-6',
          modelProvider: 'anthropic',
          inputValue: '',
          outputValue: '',
          metadata: {
            session_id: 'sess-empty-prompt',
            model: 'claude-opus-4-6',
          },
          tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
        })
      })
    })

    describe('turn', () => {
      it('creates a workflow span', async () => {
        const ctx = {
          sessionId: 'sess-001',
          prompt: 'List all files',
        }

        turnCh.start.runStores(ctx, () => {
          turnCh.end.publish(ctx)
        })

        ctx.stopReason = 'end_turn'
        turnCh.asyncEnd.publish(ctx)

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'workflow',
          name: 'claude-agent-sdk.turn',
          modelProvider: 'anthropic',
          inputValue: 'List all files',
          outputValue: 'end_turn',
          metadata: {
            session_id: 'sess-001',
            stop_reason: 'end_turn',
          },
          tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
        })
      })

      it('creates a turn span without prompt or stop reason', async () => {
        const ctx = {
          sessionId: 'sess-minimal-turn',
        }

        turnCh.start.runStores(ctx, () => {
          turnCh.end.publish(ctx)
        })
        turnCh.asyncEnd.publish(ctx)

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'workflow',
          name: 'claude-agent-sdk.turn',
          modelProvider: 'anthropic',
          inputValue: '',
          outputValue: '',
          metadata: {
            session_id: 'sess-minimal-turn',
          },
          tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
        })
      })
    })

    describe('tool', () => {
      it('creates a tool span with input and output', async () => {
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
          modelProvider: 'anthropic',
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
          modelProvider: 'anthropic',
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

      it('handles null tool input and output via safeStringify', async () => {
        const ctx = {
          sessionId: 'sess-001',
          toolName: 'Noop',
          toolUseId: 'tu-null',
        }

        toolCh.start.runStores(ctx, () => {
          toolCh.end.publish(ctx)
        })
        toolCh.asyncEnd.publish(ctx)

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'tool',
          name: 'Noop',
          modelProvider: 'anthropic',
          inputValue: '',
          outputValue: '',
          metadata: {
            tool_name: 'Noop',
            tool_use_id: 'tu-null',
            session_id: 'sess-001',
          },
          tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
        })
      })

      it('falls back to default name when toolName is missing', async () => {
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
          name: 'claude-agent-sdk.tool',
          modelProvider: 'anthropic',
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
          modelProvider: 'anthropic',
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
    })

    describe('subagent', () => {
      it('creates an agent span for subagent', async () => {
        const ctx = {
          sessionId: 'sess-001',
          agentId: 'agent-abc',
          agentType: 'code-reviewer',
        }

        subagentCh.start.runStores(ctx, () => {
          subagentCh.end.publish(ctx)
        })

        ctx.transcriptPath = '/tmp/agent-abc-transcript.json'
        subagentCh.asyncEnd.publish(ctx)

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'agent',
          name: 'claude-agent-sdk.subagent',
          modelProvider: 'anthropic',
          inputValue: '',
          outputValue: '',
          metadata: {
            agent_id: 'agent-abc',
            agent_type: 'code-reviewer',
            session_id: 'sess-001',
            transcript_path: '/tmp/agent-abc-transcript.json',
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
          name: 'claude-agent-sdk.subagent',
          modelProvider: 'anthropic',
          inputValue: '',
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
