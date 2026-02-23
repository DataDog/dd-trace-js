'use strict'

const assert = require('node:assert')
const { describe, before, after, it } = require('mocha')
const { tracingChannel } = require('dc-polyfill')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')

// Use tracingChannel to match the shimmer's channel contract.
// tracingChannel('apm:X') creates channels at tracing:apm:X:{start,end,asyncEnd,error},
// which the TracingPlugin prefix 'tracing:apm:X' subscribes to.
const sessionCh = tracingChannel('apm:claude-agent-sdk:session')
const turnCh = tracingChannel('apm:claude-agent-sdk:turn')
const toolCh = tracingChannel('apm:claude-agent-sdk:tool')
const subagentCh = tracingChannel('apm:claude-agent-sdk:subagent')

describe('Plugin', () => {
  describe('claude-agent-sdk', () => {
    // Shimmer unit tests — run without agent.load so channel publishing is a no-op.
    // These test the pure logic of mergeHooks and buildTracerHooks.
    describe('shimmer', () => {
      const {
        mergeHooks,
        buildTracerHooks,
        wrapQuery,
      } = require('../../datadog-instrumentations/src/claude-agent-sdk')

      describe('mergeHooks', () => {
        it('merges tracer hooks with null user hooks', () => {
          const tracerHooks = {
            SessionStart: [{ hooks: [() => ({})] }],
            Stop: [{ hooks: [() => ({})] }],
          }

          const merged = mergeHooks(null, tracerHooks)

          assert.equal(merged.SessionStart.length, 1)
          assert.equal(merged.Stop.length, 1)
        })

        it('merges tracer hooks with undefined user hooks', () => {
          const tracerHooks = {
            SessionStart: [{ hooks: [() => ({})] }],
          }

          const merged = mergeHooks(undefined, tracerHooks)

          assert.equal(merged.SessionStart.length, 1)
        })

        it('merges user hooks and tracer hooks for the same event', () => {
          const userHooks = {
            SessionStart: [{ hooks: [() => ({ decision: 'allow' })] }],
          }
          const tracerHooks = {
            SessionStart: [{ hooks: [() => ({})] }],
            Stop: [{ hooks: [() => ({})] }],
          }

          const merged = mergeHooks(userHooks, tracerHooks)

          assert.equal(merged.SessionStart.length, 2)
          assert.equal(merged.Stop.length, 1)
        })

        it('preserves user hooks for events the tracer does not trace', () => {
          const userHooks = {
            CustomEvent: [{ hooks: [() => ({ allowed: true })] }],
            SessionStart: [{ hooks: [() => ({})] }],
          }
          const tracerHooks = {
            SessionStart: [{ hooks: [() => ({})] }],
          }

          const merged = mergeHooks(userHooks, tracerHooks)

          assert.equal(merged.SessionStart.length, 2)
          assert.equal(merged.CustomEvent.length, 1)
        })

        it('places user hooks before tracer hooks in the array', () => {
          const userMatcher = { hooks: [() => 'user'] }
          const tracerMatcher = { hooks: [() => 'tracer'] }

          const merged = mergeHooks(
            { SessionStart: [userMatcher] },
            { SessionStart: [tracerMatcher] }
          )

          assert.strictEqual(merged.SessionStart[0], userMatcher)
          assert.strictEqual(merged.SessionStart[1], tracerMatcher)
        })
      })

      describe('buildTracerHooks', () => {
        it('creates hooks for all expected events', () => {
          const sessionCtx = {
            pendingTools: new Map(),
            pendingSubagents: new Map(),
            currentTurn: null,
          }

          const hooks = buildTracerHooks(sessionCtx)

          const expectedEvents = [
            'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop',
            'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
            'SubagentStart', 'SubagentStop',
          ]

          for (const event of expectedEvents) {
            assert.ok(hooks[event], `should have ${event} hook`)
            assert.equal(hooks[event].length, 1, `${event} should have one matcher`)
            assert.equal(hooks[event][0].hooks.length, 1, `${event} matcher should have one hook`)
          }
        })

        it('SessionStart sets sessionId and source', () => {
          const sessionCtx = { pendingTools: new Map(), pendingSubagents: new Map() }
          const hooks = buildTracerHooks(sessionCtx)

          const result = hooks.SessionStart[0].hooks[0]({
            session_id: 'sess-123',
            source: 'startup',
          })

          assert.equal(sessionCtx.sessionId, 'sess-123')
          assert.equal(sessionCtx.source, 'startup')
          assert.deepStrictEqual(result, {})
        })

        it('SessionEnd sets endReason', () => {
          const sessionCtx = { pendingTools: new Map(), pendingSubagents: new Map() }
          const hooks = buildTracerHooks(sessionCtx)

          hooks.SessionEnd[0].hooks[0]({ reason: 'completed' })

          assert.equal(sessionCtx.endReason, 'completed')
        })

        it('UserPromptSubmit creates a turnCtx on sessionCtx', () => {
          const sessionCtx = {
            pendingTools: new Map(),
            pendingSubagents: new Map(),
            currentTurn: null,
          }
          const hooks = buildTracerHooks(sessionCtx)

          hooks.UserPromptSubmit[0].hooks[0]({
            session_id: 'sess-123',
            prompt: 'What files exist?',
          })

          assert.ok(sessionCtx.currentTurn)
          assert.equal(sessionCtx.currentTurn.sessionId, 'sess-123')
          assert.equal(sessionCtx.currentTurn.prompt, 'What files exist?')
        })

        it('Stop sets stopReason and clears currentTurn', () => {
          const sessionCtx = {
            pendingTools: new Map(),
            pendingSubagents: new Map(),
            currentTurn: { sessionId: 'sess-123' },
          }
          const hooks = buildTracerHooks(sessionCtx)

          hooks.Stop[0].hooks[0]({ stop_reason: 'end_turn' })

          assert.equal(sessionCtx.currentTurn, null)
        })

        it('Stop is a no-op when there is no currentTurn', () => {
          const sessionCtx = {
            pendingTools: new Map(),
            pendingSubagents: new Map(),
            currentTurn: null,
          }
          const hooks = buildTracerHooks(sessionCtx)

          const result = hooks.Stop[0].hooks[0]({ stop_reason: 'end_turn' })

          assert.deepStrictEqual(result, {})
          assert.equal(sessionCtx.currentTurn, null)
        })

        it('PreToolUse adds a tool context to pendingTools', () => {
          const sessionCtx = { pendingTools: new Map(), pendingSubagents: new Map() }
          const hooks = buildTracerHooks(sessionCtx)

          hooks.PreToolUse[0].hooks[0]({
            session_id: 'sess-123',
            tool_name: 'Read',
            tool_input: { file_path: '/tmp/x' },
            tool_use_id: 'tu-1',
          }, 'tu-1')

          assert.ok(sessionCtx.pendingTools.has('tu-1'))
          const toolCtx = sessionCtx.pendingTools.get('tu-1')
          assert.equal(toolCtx.toolName, 'Read')
          assert.equal(toolCtx.toolUseId, 'tu-1')
        })

        it('PreToolUse falls back to input.tool_use_id when toolUseId param is missing', () => {
          const sessionCtx = { pendingTools: new Map(), pendingSubagents: new Map() }
          const hooks = buildTracerHooks(sessionCtx)

          hooks.PreToolUse[0].hooks[0]({
            session_id: 'sess-123',
            tool_name: 'Bash',
            tool_input: { command: 'ls' },
            tool_use_id: 'tu-fallback',
          })

          assert.ok(sessionCtx.pendingTools.has('tu-fallback'))
        })

        it('PreToolUse is a no-op when neither toolUseId param nor input.tool_use_id exist', () => {
          const sessionCtx = { pendingTools: new Map(), pendingSubagents: new Map() }
          const hooks = buildTracerHooks(sessionCtx)

          const result = hooks.PreToolUse[0].hooks[0]({
            session_id: 'sess-123',
            tool_name: 'Read',
            tool_input: {},
          })

          assert.deepStrictEqual(result, {})
          assert.equal(sessionCtx.pendingTools.size, 0)
        })

        it('PostToolUse removes tool from pendingTools and sets toolResponse', () => {
          const sessionCtx = { pendingTools: new Map(), pendingSubagents: new Map() }
          sessionCtx.pendingTools.set('tu-1', { toolName: 'Read', toolUseId: 'tu-1' })

          const hooks = buildTracerHooks(sessionCtx)

          hooks.PostToolUse[0].hooks[0]({ tool_response: 'file contents' }, 'tu-1')

          assert.equal(sessionCtx.pendingTools.size, 0)
        })

        it('PostToolUse is a no-op for unknown tool IDs', () => {
          const sessionCtx = { pendingTools: new Map(), pendingSubagents: new Map() }
          const hooks = buildTracerHooks(sessionCtx)

          const result = hooks.PostToolUse[0].hooks[0]({ tool_response: 'data' }, 'unknown-id')

          assert.deepStrictEqual(result, {})
        })

        it('PostToolUseFailure removes tool from pendingTools and sets error', () => {
          const sessionCtx = { pendingTools: new Map(), pendingSubagents: new Map() }
          const toolCtx = { toolName: 'Bash', toolUseId: 'tu-err' }
          sessionCtx.pendingTools.set('tu-err', toolCtx)

          const hooks = buildTracerHooks(sessionCtx)
          const err = new Error('command failed')

          hooks.PostToolUseFailure[0].hooks[0]({ error: err }, 'tu-err')

          assert.equal(sessionCtx.pendingTools.size, 0)
          assert.strictEqual(toolCtx.error, err)
        })

        it('PostToolUseFailure is a no-op for unknown tool IDs', () => {
          const sessionCtx = { pendingTools: new Map(), pendingSubagents: new Map() }
          const hooks = buildTracerHooks(sessionCtx)

          const result = hooks.PostToolUseFailure[0].hooks[0](
            { error: new Error('fail') },
            'unknown-id'
          )

          assert.deepStrictEqual(result, {})
        })

        it('SubagentStart adds a subagent context to pendingSubagents', () => {
          const sessionCtx = { pendingTools: new Map(), pendingSubagents: new Map() }
          const hooks = buildTracerHooks(sessionCtx)

          hooks.SubagentStart[0].hooks[0]({
            session_id: 'sess-123',
            agent_id: 'agent-abc',
            agent_type: 'code-reviewer',
          })

          assert.ok(sessionCtx.pendingSubagents.has('agent-abc'))
          const ctx = sessionCtx.pendingSubagents.get('agent-abc')
          assert.equal(ctx.agentType, 'code-reviewer')
        })

        it('SubagentStart is a no-op when agent_id is missing', () => {
          const sessionCtx = { pendingTools: new Map(), pendingSubagents: new Map() }
          const hooks = buildTracerHooks(sessionCtx)

          const result = hooks.SubagentStart[0].hooks[0]({
            session_id: 'sess-123',
          })

          assert.deepStrictEqual(result, {})
          assert.equal(sessionCtx.pendingSubagents.size, 0)
        })

        it('SubagentStop removes subagent from pendingSubagents and sets transcriptPath', () => {
          const sessionCtx = { pendingTools: new Map(), pendingSubagents: new Map() }
          const subCtx = { agentId: 'agent-abc', agentType: 'code-reviewer' }
          sessionCtx.pendingSubagents.set('agent-abc', subCtx)

          const hooks = buildTracerHooks(sessionCtx)

          hooks.SubagentStop[0].hooks[0]({
            agent_id: 'agent-abc',
            agent_transcript_path: '/tmp/transcript.json',
          })

          assert.equal(sessionCtx.pendingSubagents.size, 0)
          assert.equal(subCtx.transcriptPath, '/tmp/transcript.json')
        })

        it('SubagentStop is a no-op for unknown agent IDs', () => {
          const sessionCtx = { pendingTools: new Map(), pendingSubagents: new Map() }
          const hooks = buildTracerHooks(sessionCtx)

          const result = hooks.SubagentStop[0].hooks[0]({
            agent_id: 'unknown-agent',
            agent_transcript_path: '/tmp/t.json',
          })

          assert.deepStrictEqual(result, {})
        })
      })

      describe('wrapQuery', () => {
        it('passes through to original when no subscribers', () => {
          let called = false
          const originalQuery = function () {
            called = true
            return 'result'
          }

          // wrapQuery returns a new function that wraps originalQuery
          const wrapped = wrapQuery(originalQuery)

          // Without subscribers (no agent.load), hasSubscribers is false
          // so it should call originalQuery directly
          const result = wrapped({ prompt: 'test', options: {} })

          assert.equal(called, true)
          assert.equal(result, 'result')
        })

        it('returns the wrappedQuery function with the correct name', () => {
          const wrapped = wrapQuery(function original () {})

          assert.equal(wrapped.name, 'wrappedQuery')
        })
      })
    })

    withVersions('claude-agent-sdk', '@anthropic-ai/claude-agent-sdk', (version) => {
      before(async () => {
        await agent.load('claude-agent-sdk')
      })

      after(() => agent.close({ ritmReset: false }))

      // NOTE: The SDK is pure ESM ("type": "module", "main": "sdk.mjs") which
      // cannot be loaded via CJS require() in the test harness. Shimmer wrapping
      // is verified in the shimmer unit tests above (wrapQuery, mergeHooks,
      // buildTracerHooks). Full ESM integration testing requires a subprocess
      // with --import dd-trace/initialize.mjs (deferred to follow-up).

      describe('session span', () => {
        it('creates an agent span for a session', async () => {
          const tracesPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.equal(span.name, 'claude-agent-sdk.session')
            assert.equal(span.meta['claude-agent-sdk.session.id'], 'test-session-123')
            assert.equal(span.meta['claude-agent-sdk.session.model'], 'claude-opus-4-6')
          })

          const ctx = {
            prompt: 'Hello, world!',
            model: 'claude-opus-4-6',
            sessionId: 'test-session-123',
            permissionMode: 'default',
          }

          sessionCh.start.runStores(ctx, () => {
            sessionCh.end.publish(ctx)
          })

          ctx.endReason = 'completed'
          sessionCh.asyncEnd.publish(ctx)

          await tracesPromise
        })

        it('tags resumed sessions with parent_session_id', async () => {
          const tracesPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.equal(span.name, 'claude-agent-sdk.session')
            assert.equal(
              span.meta['claude-agent-sdk.session.parent_session_id'],
              'original-session-456'
            )
          })

          const ctx = {
            prompt: 'Continue from before',
            model: 'claude-opus-4-6',
            sessionId: 'resumed-session-789',
            resume: 'original-session-456',
          }

          sessionCh.start.runStores(ctx, () => {
            sessionCh.end.publish(ctx)
          })
          sessionCh.asyncEnd.publish(ctx)

          await tracesPromise
        })

        it('creates a session span with minimal fields', async () => {
          const tracesPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.equal(span.name, 'claude-agent-sdk.session')
            assert.equal(span.meta['claude-agent-sdk.session.model'], undefined)
            assert.equal(span.meta['claude-agent-sdk.session.parent_session_id'], undefined)
            assert.equal(span.meta['claude-agent-sdk.session.permission_mode'], undefined)
          })

          const ctx = {
            prompt: 'Hello',
          }

          sessionCh.start.runStores(ctx, () => {
            sessionCh.end.publish(ctx)
          })
          sessionCh.asyncEnd.publish(ctx)

          await tracesPromise
        })

        it('tags permission_mode on the session span', async () => {
          const tracesPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.equal(span.meta['claude-agent-sdk.session.permission_mode'], 'plan')
          })

          const ctx = {
            prompt: 'Plan something',
            model: 'claude-opus-4-6',
            sessionId: 'perm-session',
            permissionMode: 'plan',
          }

          sessionCh.start.runStores(ctx, () => {
            sessionCh.end.publish(ctx)
          })
          sessionCh.asyncEnd.publish(ctx)

          await tracesPromise
        })

        it('handles session error via error channel', async () => {
          const tracesPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.equal(span.name, 'claude-agent-sdk.session')
            assert.ok(span.error)
          })

          const ctx = {
            prompt: 'This will fail',
            model: 'claude-opus-4-6',
            sessionId: 'error-session',
          }

          sessionCh.start.runStores(ctx, () => {
            sessionCh.end.publish(ctx)
          })

          ctx.error = new Error('session crashed')
          sessionCh.error.publish(ctx)
          sessionCh.asyncEnd.publish(ctx)

          await tracesPromise
        })
      })

      describe('turn span', () => {
        it('creates a workflow span for a turn', async () => {
          const tracesPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.equal(span.name, 'claude-agent-sdk.turn')
            assert.equal(span.meta['claude-agent-sdk.session.id'], 'test-session-123')
          })

          const ctx = {
            sessionId: 'test-session-123',
            prompt: 'What files are in this directory?',
          }

          turnCh.start.runStores(ctx, () => {
            turnCh.end.publish(ctx)
          })

          ctx.stopReason = 'end_turn'
          turnCh.asyncEnd.publish(ctx)

          await tracesPromise
        })

        it('creates a turn span with minimal fields', async () => {
          const tracesPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.equal(span.name, 'claude-agent-sdk.turn')
            assert.equal(span.meta['claude-agent-sdk.session.id'], undefined)
          })

          const ctx = {}

          turnCh.start.runStores(ctx, () => {
            turnCh.end.publish(ctx)
          })
          turnCh.asyncEnd.publish(ctx)

          await tracesPromise
        })
      })

      describe('tool span', () => {
        it('creates a tool span for a tool call', async () => {
          const tracesPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.equal(span.name, 'claude-agent-sdk.tool')
            assert.equal(span.meta['claude-agent-sdk.tool.name'], 'Read')
            assert.equal(span.meta['claude-agent-sdk.tool.use_id'], 'tool-use-abc')
          })

          const ctx = {
            sessionId: 'test-session-123',
            toolName: 'Read',
            toolInput: { file_path: '/tmp/test.txt' },
            toolUseId: 'tool-use-abc',
          }

          toolCh.start.runStores(ctx, () => {
            toolCh.end.publish(ctx)
          })

          ctx.toolResponse = 'file contents here'
          toolCh.asyncEnd.publish(ctx)

          await tracesPromise
        })

        it('tags tool errors', async () => {
          const tracesPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.equal(span.name, 'claude-agent-sdk.tool')
            assert.equal(span.meta['claude-agent-sdk.tool.name'], 'Bash')
            assert.ok(span.error)
          })

          const ctx = {
            sessionId: 'test-session-123',
            toolName: 'Bash',
            toolInput: { command: 'false' },
            toolUseId: 'tool-use-err',
          }

          toolCh.start.runStores(ctx, () => {
            toolCh.end.publish(ctx)
          })

          ctx.error = new Error('command failed with exit code 1')
          toolCh.error.publish(ctx)
          toolCh.asyncEnd.publish(ctx)

          await tracesPromise
        })

        it('creates a tool span with minimal fields', async () => {
          const tracesPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.equal(span.name, 'claude-agent-sdk.tool')
            assert.equal(span.meta['claude-agent-sdk.tool.name'], undefined)
            assert.equal(span.meta['claude-agent-sdk.tool.use_id'], undefined)
            assert.equal(span.meta['claude-agent-sdk.session.id'], undefined)
          })

          const ctx = {}

          toolCh.start.runStores(ctx, () => {
            toolCh.end.publish(ctx)
          })
          toolCh.asyncEnd.publish(ctx)

          await tracesPromise
        })
      })

      describe('subagent span', () => {
        it('creates an agent span for a subagent', async () => {
          const tracesPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.equal(span.name, 'claude-agent-sdk.subagent')
            assert.equal(span.meta['claude-agent-sdk.subagent.id'], 'agent-xyz')
            assert.equal(span.meta['claude-agent-sdk.subagent.type'], 'code-reviewer')
          })

          const ctx = {
            sessionId: 'test-session-123',
            agentId: 'agent-xyz',
            agentType: 'code-reviewer',
          }

          subagentCh.start.runStores(ctx, () => {
            subagentCh.end.publish(ctx)
          })

          ctx.transcriptPath = '/tmp/transcript.json'
          subagentCh.asyncEnd.publish(ctx)

          await tracesPromise
        })

        it('creates a subagent span with minimal fields', async () => {
          const tracesPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.equal(span.name, 'claude-agent-sdk.subagent')
            assert.equal(span.meta['claude-agent-sdk.subagent.id'], undefined)
            assert.equal(span.meta['claude-agent-sdk.subagent.type'], undefined)
            assert.equal(span.meta['claude-agent-sdk.session.id'], undefined)
          })

          const ctx = {}

          subagentCh.start.runStores(ctx, () => {
            subagentCh.end.publish(ctx)
          })
          subagentCh.asyncEnd.publish(ctx)

          await tracesPromise
        })
      })

      describe('span hierarchy', () => {
        it('nests tool span inside session span', async () => {
          const tracesPromise = agent.assertSomeTraces(traces => {
            const spans = traces[0]
            assert.ok(spans.length >= 2, 'should have at least 2 spans')

            const sessionSpan = spans.find(s => s.name === 'claude-agent-sdk.session')
            const toolSpan = spans.find(s => s.name === 'claude-agent-sdk.tool')

            assert.ok(sessionSpan, 'should have a session span')
            assert.ok(toolSpan, 'should have a tool span')
            assert.equal(
              toolSpan.parent_id.toString(),
              sessionSpan.span_id.toString(),
              'tool span should be child of session span'
            )
          })

          const sessionCtx = {
            prompt: 'Do something',
            model: 'claude-opus-4-6',
            sessionId: 'hierarchy-session',
          }

          sessionCh.start.runStores(sessionCtx, () => {
            sessionCh.end.publish(sessionCtx)

            // Tool inside session context
            const toolCtx = {
              sessionId: 'hierarchy-session',
              toolName: 'Read',
              toolUseId: 'tool-hierarchy',
            }
            toolCh.start.runStores(toolCtx, () => {
              toolCh.end.publish(toolCtx)
            })
            toolCh.asyncEnd.publish(toolCtx)
          })

          sessionCh.asyncEnd.publish(sessionCtx)

          await tracesPromise
        })
      })
    })
  })
})
