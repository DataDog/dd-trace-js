'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const log = require('../../src/log')
const { buildAgentDeclaration, mergeAgentManifest } = require('../../src/llmobs/agent-manifest')

describe('agent manifest', () => {
  describe('buildAgentDeclaration', () => {
    beforeEach(() => {
      sinon.spy(log, 'warn')
    })

    afterEach(() => {
      sinon.restore()
    })

    function manifestOf (agent) {
      return buildAgentDeclaration(agent)?.manifest
    }

    it('builds every supported field', () => {
      const declaration = buildAgentDeclaration({
        version: '2.1.0',
        name: 'travel_desk',
        instructions: 'Book travel.',
        model: 'gpt-4o',
        modelSettings: { temperature: 0.1, max_tokens: 1024 },
        tools: [{
          name: 'get_weather',
          description: 'Look up the weather.',
          parameters: { city: { type: 'string', required: true } },
        }],
      })

      assert.deepStrictEqual(declaration, {
        version: '2.1.0',
        manifest: {
          name: 'travel_desk',
          instructions: 'Book travel.',
          model: 'gpt-4o',
          model_settings: { temperature: 0.1, max_tokens: 1024 },
          tools: [{
            name: 'get_weather',
            description: 'Look up the weather.',
            parameters: { city: { type: 'string', required: true } },
          }],
        },
      })
      sinon.assert.notCalled(log.warn)
    })

    it('declares a version without a manifest for a version-only agent', () => {
      assert.deepStrictEqual(buildAgentDeclaration({ version: '1.0.0' }), { version: '1.0.0', manifest: undefined })
    })

    const versions = [['1.0.0', '1.0.0'], [2, '2'], [0, undefined], ['', undefined], [{}, undefined]]
    for (const [version, expected] of versions) {
      it(`reads version ${JSON.stringify(version)} as ${JSON.stringify(expected)}`, () => {
        assert.strictEqual(buildAgentDeclaration({ version, name: 'a' }).version, expected)
      })
    }

    it('returns undefined for an agent that declares nothing', () => {
      assert.strictEqual(buildAgentDeclaration({}), undefined)
      assert.strictEqual(buildAgentDeclaration({ name: '', tools: [], modelSettings: {} }), undefined)
      sinon.assert.notCalled(log.warn)
    })

    for (const agent of [undefined, null, 'agent', 1, ['name'], new (class Agent { name = 'a' })()]) {
      it(`drops and warns on a non-plain-object agent (${Object.prototype.toString.call(agent)})`, () => {
        assert.strictEqual(buildAgentDeclaration(agent), undefined)
        sinon.assert.calledOnceWithExactly(log.warn, 'Dropping agent annotation, the agent must be a plain object.')
      })
    }

    it('never throws on an agent whose fields cannot be read', () => {
      const agent = { version: '1.0.0' }
      Object.defineProperty(agent, 'instructions', { enumerable: true, get () { throw new Error('dynamic') } })

      assert.strictEqual(buildAgentDeclaration(agent), undefined)
      sinon.assert.calledOnceWithExactly(log.warn, 'Dropping agent annotation, its fields could not be read.')
    })

    it('never throws on a revoked Proxy', () => {
      const { proxy, revoke } = Proxy.revocable({}, {})
      revoke()

      assert.strictEqual(buildAgentDeclaration(proxy), undefined)
    })

    it('drops non-string labels and warns with their names only', () => {
      assert.deepStrictEqual(
        manifestOf({ name: 'kept', instructions: { text: 'secret' }, model: 42 }),
        { name: 'kept' }
      )
      sinon.assert.calledOnceWithExactly(
        log.warn,
        'Dropping unsupported agent manifest fields: %s',
        'instructions, model'
      )
    })

    describe('model settings', () => {
      it('keeps only allowed keys and warns with the dropped key names', () => {
        const manifest = manifestOf({
          modelSettings: { temperature: 0, extra_headers: { authorization: 'secret' }, apiKey: 'secret' },
        })

        assert.deepStrictEqual(manifest, { model_settings: { temperature: 0 } })
        sinon.assert.calledOnceWithExactly(
          log.warn,
          'Dropping unsupported agent manifest fields: %s',
          'modelSettings.extra_headers, modelSettings.apiKey'
        )
      })

      it('converts camelCase setting keys to snake_case', () => {
        const manifest = manifestOf({
          modelSettings: { maxTokens: 10, topP: 0.9, stopSequences: ['END'], parallelToolCalls: false },
        })

        assert.deepStrictEqual(manifest, {
          model_settings: { max_tokens: 10, top_p: 0.9, stop_sequences: ['END'], parallel_tool_calls: false },
        })
      })

      it('does not read a snake_case model_settings field', () => {
        assert.strictEqual(manifestOf({ model_settings: { temperature: 0.1 } }), undefined)
      })

      it('keeps flat numeric objects such as logit_bias', () => {
        assert.deepStrictEqual(
          manifestOf({ modelSettings: { logit_bias: { 50256: -100 } } }),
          { model_settings: { logit_bias: { 50256: -100 } } }
        )
      })

      it('treats unset values as declaring nothing', () => {
        assert.strictEqual(
          manifestOf({ modelSettings: { tool_choice: '', seed: null, stop_sequences: [], logit_bias: {} } }),
          undefined
        )
        sinon.assert.notCalled(log.warn)
      })

      it('drops values that are not flat scalars', () => {
        const manifest = manifestOf({
          modelSettings: {
            temperature: Number.NaN,
            top_p: Infinity,
            stop_sequences: ['END', { nested: true }],
            logit_bias: { 1: 'high' },
            tool_choice: { type: 'function' },
            timeout: 10n,
          },
        })

        assert.strictEqual(manifest, undefined)
        sinon.assert.calledOnce(log.warn)
      })

      it('drops a non-plain-object modelSettings', () => {
        assert.strictEqual(manifestOf({ modelSettings: new Map([['temperature', 0]]) }), undefined)
        sinon.assert.calledOnceWithExactly(log.warn, 'Dropping unsupported agent manifest fields: %s', 'modelSettings')
      })
    })

    describe('tools', () => {
      it('drops tools without a name and keeps the rest', () => {
        const manifest = manifestOf({
          tools: [
            { description: 'nameless' },
            { name: '' },
            'get_time',
            { name: 'get_time', description: 5 },
          ],
        })

        assert.deepStrictEqual(manifest, { tools: [{ name: 'get_time' }] })
        sinon.assert.calledOnceWithExactly(
          log.warn,
          'Dropping unsupported agent manifest fields: %s',
          'tools[0], tools[1], tools[2]'
        )
      })

      it('omits required when false and parameters with nothing to report', () => {
        const manifest = manifestOf({
          tools: [{
            name: 'search',
            parameters: {
              query: { type: 'string', required: false },
              limit: { type: 5 },
              raw: 'string',
            },
          }],
        })

        assert.deepStrictEqual(manifest, {
          tools: [{ name: 'search', parameters: { query: { type: 'string' } } }],
        })
      })

      it('flattens a JSON Schema object', () => {
        const manifest = manifestOf({
          tools: [{
            name: 'get_weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' }, unit: { type: 'string' } },
              required: ['city'],
            },
          }],
        })

        assert.deepStrictEqual(manifest, {
          tools: [{
            name: 'get_weather',
            parameters: { city: { type: 'string', required: true }, unit: { type: 'string' } },
          }],
        })
      })

      it('flattens a JSON Schema object without a required list', () => {
        const manifest = manifestOf({
          tools: [{ name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
        })

        assert.deepStrictEqual(manifest, {
          tools: [{ name: 'get_weather', parameters: { city: { type: 'string' } } }],
        })
      })

      it('flattens a JSON Schema object marked only by its required list', () => {
        const manifest = manifestOf({
          tools: [{ name: 'get_weather', parameters: { properties: { city: {} }, required: ['city'] } }],
        })

        assert.deepStrictEqual(manifest, {
          tools: [{ name: 'get_weather', parameters: { city: { required: true } } }],
        })
      })

      it('reads a mapping with a parameter named properties as a mapping', () => {
        const manifest = manifestOf({
          tools: [{ name: 'describe', parameters: { properties: { type: 'object' } } }],
        })

        assert.deepStrictEqual(manifest, {
          tools: [{ name: 'describe', parameters: { properties: { type: 'object' } } }],
        })
      })

      it('drops schema-library instances rather than reading their fields', () => {
        class ZodObject {
          def = { type: 'object' }
          shape = { city: { type: 'string' } }
        }

        const manifest = manifestOf({ tools: [{ name: 'get_weather', parameters: new ZodObject() }] })

        assert.deepStrictEqual(manifest, { tools: [{ name: 'get_weather' }] })
        sinon.assert.calledOnceWithExactly(
          log.warn,
          'Dropping unsupported agent manifest fields: %s',
          'tools[0].parameters'
        )
      })

      it('does not read a caller-supplied framework', () => {
        assert.deepStrictEqual(manifestOf({ name: 'a', framework: 'custom' }), { name: 'a' })
      })
    })
  })

  describe('mergeAgentManifest', () => {
    it('lets incoming fields win, merges model_settings and replaces tools', () => {
      const base = {
        name: 'a',
        model: 'gpt-4o',
        model_settings: { temperature: 0.1, max_tokens: 10 },
        tools: [{ name: 'one' }, { name: 'two' }],
      }
      const incoming = {
        name: 'b',
        model_settings: { temperature: 0.5 },
        tools: [{ name: 'three' }],
      }

      assert.deepStrictEqual(mergeAgentManifest(base, incoming), {
        name: 'b',
        model: 'gpt-4o',
        model_settings: { temperature: 0.5, max_tokens: 10 },
        tools: [{ name: 'three' }],
      })
      assert.deepStrictEqual(base.model_settings, { temperature: 0.1, max_tokens: 10 })
    })

    it('copies incoming when there is no base', () => {
      const incoming = { name: 'a' }
      const merged = mergeAgentManifest(undefined, incoming)

      assert.deepStrictEqual(merged, incoming)
      assert.notEqual(merged, incoming)
    })
  })
})
