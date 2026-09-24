'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { buildAgentManifest, mergeAgentManifest } = require('../../src/llmobs/agent-manifest')

describe('agent manifest', () => {
  describe('buildAgentManifest', () => {
    it('builds every supported field', () => {
      const manifest = buildAgentManifest({
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

      assert.deepStrictEqual(manifest, {
        name: 'travel_desk',
        instructions: 'Book travel.',
        model: 'gpt-4o',
        model_settings: { temperature: 0.1, max_tokens: 1024 },
        tools: [{
          name: 'get_weather',
          description: 'Look up the weather.',
          parameters: { city: { type: 'string', required: true } },
        }],
      })
    })

    it('returns undefined for a version-only agent', () => {
      assert.equal(buildAgentManifest({ version: '1.0.0' }), undefined)
    })

    for (const agent of [undefined, null, 'agent', 1, ['name']]) {
      it(`returns undefined for a non-object agent (${JSON.stringify(agent)})`, () => {
        assert.equal(buildAgentManifest(agent), undefined)
      })
    }

    it('drops unset and non-string labels', () => {
      assert.deepStrictEqual(
        buildAgentManifest({ name: '', instructions: { text: 'x' }, model: 42, tools: [], modelSettings: {} }),
        undefined
      )
      assert.deepStrictEqual(buildAgentManifest({ name: 'kept', model: null }), { name: 'kept' })
    })

    describe('model settings', () => {
      it('keeps only allowed keys', () => {
        const manifest = buildAgentManifest({
          modelSettings: { temperature: 0, extra_headers: { authorization: 'secret' }, api_key: 'secret' },
        })

        assert.deepStrictEqual(manifest, { model_settings: { temperature: 0 } })
      })

      it('accepts snake_case model_settings and camelCase setting keys', () => {
        const manifest = buildAgentManifest({
          model_settings: { maxTokens: 10, topP: 0.9, stopSequences: ['END'], parallelToolCalls: false },
        })

        assert.deepStrictEqual(manifest, {
          model_settings: { max_tokens: 10, top_p: 0.9, stop_sequences: ['END'], parallel_tool_calls: false },
        })
      })

      it('keeps flat numeric objects such as logit_bias', () => {
        const manifest = buildAgentManifest({ modelSettings: { logit_bias: { 50256: -100 } } })

        assert.deepStrictEqual(manifest, { model_settings: { logit_bias: { 50256: -100 } } })
      })

      it('drops values that are not flat scalars', () => {
        const manifest = buildAgentManifest({
          modelSettings: {
            temperature: Number.NaN,
            top_p: Infinity,
            seed: null,
            stop_sequences: ['END', { nested: true }],
            logit_bias: { 1: 'high' },
            tool_choice: { type: 'function' },
            timeout: 10n,
            max_tokens: [],
          },
        })

        assert.equal(manifest, undefined)
      })
    })

    describe('tools', () => {
      it('drops tools without a name and keeps the rest', () => {
        const manifest = buildAgentManifest({
          tools: [
            { description: 'nameless' },
            { name: '' },
            'get_time',
            { name: 'get_time', description: 5 },
          ],
        })

        assert.deepStrictEqual(manifest, { tools: [{ name: 'get_time' }] })
      })

      it('omits required when false and parameters with nothing to report', () => {
        const manifest = buildAgentManifest({
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
        const manifest = buildAgentManifest({
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

      it('flattens a JSON Schema object marked only by its required list', () => {
        const manifest = buildAgentManifest({
          tools: [{ name: 'get_weather', parameters: { properties: { city: {} }, required: ['city'] } }],
        })

        assert.deepStrictEqual(manifest, {
          tools: [{ name: 'get_weather', parameters: { city: { required: true } } }],
        })
      })

      it('reads a mapping with a parameter named properties as a mapping', () => {
        const manifest = buildAgentManifest({
          tools: [{ name: 'describe', parameters: { properties: { type: 'object' } } }],
        })

        assert.deepStrictEqual(manifest, {
          tools: [{ name: 'describe', parameters: { properties: { type: 'object' } } }],
        })
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
