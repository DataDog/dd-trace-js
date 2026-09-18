'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

const {
  BaseEvaluator,
  BooleanStructuredOutput,
  CategoricalStructuredOutput,
  EvaluatorContext,
  EvaluatorResult,
  JSONEvaluator,
  LLMJudge,
  LengthEvaluator,
  RegexMatchEvaluator,
  ScoreStructuredOutput,
  SemanticSimilarityEvaluator,
  StringCheckEvaluator,
} = require('../../../src/llmobs/evaluators')

function ctx (fields = {}) {
  return new EvaluatorContext({
    inputData: 'input',
    outputData: null,
    expectedOutput: null,
    metadata: {},
    spanId: 'span-1',
    traceId: 'trace-1',
    ...fields,
  })
}

describe('LLMObs built-in evaluators', () => {
  describe('EvaluatorResult', () => {
    it('defaults optional fields to null', () => {
      const result = new EvaluatorResult(true)
      assert.equal(result.value, true)
      assert.equal(result.reasoning, null)
      assert.equal(result.assessment, null)
      assert.equal(result.metadata, null)
      assert.equal(result.tags, null)
    })
  })

  describe('BaseEvaluator', () => {
    it('defaults the name to the class name and requires evaluate()', () => {
      class MyEvaluator extends BaseEvaluator {}
      const evaluator = new MyEvaluator()
      assert.equal(evaluator.name, 'MyEvaluator')
      assert.throws(() => evaluator.evaluate(ctx()), { name: 'Error' })
    })

    it('rejects names that are not valid evaluator names', () => {
      assert.throws(() => new LengthEvaluator({ minLength: 1, name: '' }), { name: 'Error' })
    })
  })

  describe('LengthEvaluator', () => {
    it('validates constructor options', () => {
      assert.throws(() => new LengthEvaluator(), { message: /minLength or maxLength/ })
      assert.throws(() => new LengthEvaluator({ minLength: -1 }), { message: /non-negative/ })
      assert.throws(() => new LengthEvaluator({ minLength: 5, maxLength: 4 }), { message: /minLength/ })
      assert.throws(() => new LengthEvaluator({ minLength: 1, countType: 'bytes' }), { message: /countType/ })
      assert.equal(new LengthEvaluator({ minLength: 4, maxLength: 4 }).minLength, 4)
    })

    it('checks inclusive character bounds', () => {
      const evaluator = new LengthEvaluator({ minLength: 2, maxLength: 4 })
      assert.equal(evaluator.evaluate(ctx({ outputData: 'ab' })).value, true)
      assert.equal(evaluator.evaluate(ctx({ outputData: 'abcd' })).value, true)
      assert.equal(evaluator.evaluate(ctx({ outputData: 'a' })).value, false)
      assert.equal(evaluator.evaluate(ctx({ outputData: 'abcde' })).value, false)
      assert.equal(evaluator.evaluate(ctx({ outputData: 'abcde' })).assessment, 'fail')
      assert.equal(evaluator.evaluate(ctx({ outputData: 'abc' })).assessment, 'pass')
    })

    it('counts words and lines', () => {
      const words = new LengthEvaluator({ minLength: 2, countType: 'words' })
      assert.equal(words.evaluate(ctx({ outputData: 'one two' })).value, true)
      assert.equal(words.evaluate(ctx({ outputData: 'one' })).value, false)
      const lines = new LengthEvaluator({ maxLength: 1, countType: 'lines' })
      assert.equal(lines.evaluate(ctx({ outputData: 'one' })).value, true)
      assert.equal(lines.evaluate(ctx({ outputData: 'one\ntwo' })).value, false)
    })

    it('fails on null output and supports an output extractor', () => {
      const evaluator = new LengthEvaluator({ minLength: 1, outputExtractor: output => output?.text ?? null })
      assert.equal(evaluator.evaluate(ctx({ outputData: null })).value, false)
      assert.equal(new LengthEvaluator({ minLength: 1 }).evaluate(ctx({ outputData: null })).value, false)
      assert.equal(evaluator.evaluate(ctx({ outputData: { text: 'x' } })).value, true)
    })
  })

  describe('JSONEvaluator', () => {
    it('validates JSON output and required keys', () => {
      const evaluator = new JSONEvaluator({ requiredKeys: ['a'] })
      assert.equal(evaluator.evaluate(ctx({ outputData: '{"a": 1}' })).value, true)
      assert.equal(evaluator.evaluate(ctx({ outputData: '{"b": 1}' })).value, false)
      assert.equal(evaluator.evaluate(ctx({ outputData: { a: 1 } })).value, true)
      assert.equal(evaluator.evaluate(ctx({ outputData: 'not json' })).value, false)
      assert.equal(evaluator.evaluate(ctx({ outputData: null })).value, false)
    })

    it('accepts any valid JSON when no keys are required', () => {
      const evaluator = new JSONEvaluator()
      assert.equal(evaluator.evaluate(ctx({ outputData: '[1, 2]' })).value, true)
      assert.equal(evaluator.evaluate(ctx({ outputData: '{' })).value, false)
    })
  })

  describe('StringCheckEvaluator', () => {
    it('validates the operation', () => {
      assert.throws(() => new StringCheckEvaluator({ operation: 'startswith' }), { message: /operation/ })
    })

    it('compares output against expected output', () => {
      const eq = new StringCheckEvaluator()
      assert.equal(eq.evaluate(ctx({ outputData: 'a', expectedOutput: 'a' })).value, true)
      assert.equal(eq.evaluate(ctx({ outputData: 'a', expectedOutput: 'A' })).value, false)
      const ne = new StringCheckEvaluator({ operation: 'ne' })
      assert.equal(ne.evaluate(ctx({ outputData: 'a', expectedOutput: 'b' })).value, true)
      const insensitive = new StringCheckEvaluator({ caseSensitive: false, stripWhitespace: true })
      assert.equal(insensitive.evaluate(ctx({ outputData: ' A ', expectedOutput: 'a' })).value, true)
    })

    it('supports contains and icontains', () => {
      const contains = new StringCheckEvaluator({ operation: 'contains' })
      assert.equal(contains.evaluate(ctx({ outputData: 'hello world', expectedOutput: 'world' })).value, true)
      assert.equal(contains.evaluate(ctx({ outputData: 'hello world', expectedOutput: 'WORLD' })).value, false)
      const icontains = new StringCheckEvaluator({ operation: 'icontains' })
      assert.equal(icontains.evaluate(ctx({ outputData: 'hello world', expectedOutput: 'WORLD' })).value, true)
    })

    it('handles null values like Python', () => {
      const eq = new StringCheckEvaluator()
      assert.equal(eq.evaluate(ctx({ outputData: null, expectedOutput: null })).value, true)
      assert.equal(eq.evaluate(ctx({ outputData: 'a', expectedOutput: null })).value, false)
      const ne = new StringCheckEvaluator({ operation: 'ne' })
      assert.equal(ne.evaluate(ctx({ outputData: 'a', expectedOutput: null })).value, true)
      const contains = new StringCheckEvaluator({ operation: 'contains' })
      assert.equal(contains.evaluate(ctx({ outputData: null, expectedOutput: 'a' })).value, false)
    })

    it('uses extractors for both sides', () => {
      const evaluator = new StringCheckEvaluator({
        outputExtractor: output => output.answer,
        expectedOutputExtractor: expected => expected.answer,
      })
      const same = ctx({ outputData: { answer: 'x' }, expectedOutput: { answer: 'x' } })
      assert.equal(evaluator.evaluate(same).value, true)
    })
  })

  describe('RegexMatchEvaluator', () => {
    it('validates the pattern and match mode', () => {
      assert.throws(() => new RegexMatchEvaluator({}), { message: /pattern/ })
      assert.throws(() => new RegexMatchEvaluator({ pattern: 'a', matchMode: 'find' }), { message: /matchMode/ })
      assert.throws(() => new RegexMatchEvaluator({ pattern: '(' }), { message: /Invalid regex pattern/ })
    })

    it('supports search, match and fullmatch semantics', () => {
      const search = new RegexMatchEvaluator({ pattern: String.raw`\d+` })
      assert.equal(search.evaluate(ctx({ outputData: 'abc 123' })).value, true)
      const match = new RegexMatchEvaluator({ pattern: String.raw`\d+`, matchMode: 'match' })
      assert.equal(match.evaluate(ctx({ outputData: 'abc 123' })).value, false)
      assert.equal(match.evaluate(ctx({ outputData: '123 abc' })).value, true)
      const fullmatch = new RegexMatchEvaluator({ pattern: String.raw`\d+`, matchMode: 'fullmatch' })
      assert.equal(fullmatch.evaluate(ctx({ outputData: '123 abc' })).value, false)
      assert.equal(fullmatch.evaluate(ctx({ outputData: '123' })).value, true)
    })

    it('supports flags and fails on null output', () => {
      const evaluator = new RegexMatchEvaluator({ pattern: 'abc', flags: 'i' })
      assert.equal(evaluator.evaluate(ctx({ outputData: 'ABC' })).value, true)
      assert.equal(evaluator.evaluate(ctx({ outputData: null })).value, false)
    })
  })

  describe('SemanticSimilarityEvaluator', () => {
    const embed = text => (text === 'a' ? [1, 0] : text === 'b' ? [0, 1] : [2, 0])

    it('validates the embedding function and threshold', () => {
      assert.throws(() => new SemanticSimilarityEvaluator({}), { message: /embeddingFn/ })
      assert.throws(() => new SemanticSimilarityEvaluator({ embeddingFn: embed, threshold: 1.5 }), {
        message: /threshold/,
      })
      assert.equal(new SemanticSimilarityEvaluator({ embeddingFn: embed, threshold: 1 }).threshold, 1)
      assert.equal(new SemanticSimilarityEvaluator({ embeddingFn: embed, threshold: 0 }).threshold, 0)
    })

    it('normalises cosine similarity to [0, 1] and compares to the threshold', async () => {
      const evaluator = new SemanticSimilarityEvaluator({ embeddingFn: embed, threshold: 0.7 })
      const identical = await evaluator.evaluate(ctx({ outputData: 'a', expectedOutput: 'a' }))
      assert.equal(identical.value, 1)
      assert.equal(identical.assessment, 'pass')
      const orthogonal = await evaluator.evaluate(ctx({ outputData: 'a', expectedOutput: 'b' }))
      assert.equal(orthogonal.value, 0.5)
      assert.equal(orthogonal.assessment, 'fail')
    })

    it('handles null values and async embedding functions', async () => {
      const evaluator = new SemanticSimilarityEvaluator({ embeddingFn: async text => embed(text) })
      const bothNull = await evaluator.evaluate(ctx({ outputData: null, expectedOutput: null }))
      assert.equal(bothNull.value, 1)
      assert.equal(bothNull.assessment, 'pass')
      const oneNull = await evaluator.evaluate(ctx({ outputData: 'a', expectedOutput: null }))
      assert.equal(oneNull.value, 0)
      assert.equal(oneNull.assessment, 'fail')
      const both = await evaluator.evaluate(ctx({ outputData: 'c', expectedOutput: 'c' }))
      assert.equal(both.value, 1)
    })
  })

  describe('structured outputs', () => {
    it('builds the boolean schema and assessment', () => {
      const output = new BooleanStructuredOutput({ description: 'Is it correct?', passWhen: true, reasoning: true })
      const schema = output.toJsonSchema()
      assert.deepEqual(Object.keys(schema.properties), ['boolean_eval', 'reasoning'])
      assert.deepEqual(schema.required, ['boolean_eval', 'reasoning'])
      assert.equal(schema.additionalProperties, false)
      assert.equal(output.assess(true), 'pass')
      assert.equal(output.assess(false), 'fail')
      assert.equal(new BooleanStructuredOutput({ description: 'x' }).assess(false), null)
    })

    it('omits reasoning by default', () => {
      const schema = new BooleanStructuredOutput({ description: 'x' }).toJsonSchema()
      assert.deepEqual(Object.keys(schema.properties), ['boolean_eval'])
      assert.deepEqual(schema.required, ['boolean_eval'])
    })

    it('computes score threshold assessments', () => {
      const inclusive = new ScoreStructuredOutput({
        description: 'x', minScore: 0, maxScore: 10, minThreshold: 3, maxThreshold: 7,
      })
      assert.equal(inclusive.toJsonSchema().properties.score_eval.minimum, 0)
      assert.equal(inclusive.toJsonSchema().properties.score_eval.maximum, 10)
      assert.equal(inclusive.assess(3), 'pass')
      assert.equal(inclusive.assess(7), 'pass')
      assert.equal(inclusive.assess(2), 'fail')
      assert.equal(inclusive.assess(8), 'fail')
      const outside = new ScoreStructuredOutput({
        description: 'x', minScore: 0, maxScore: 10, minThreshold: 7, maxThreshold: 3,
      })
      assert.equal(outside.assess(8), 'pass')
      assert.equal(outside.assess(2), 'pass')
      assert.equal(outside.assess(5), 'fail')
      const minOnly = new ScoreStructuredOutput({ description: 'x', minScore: 0, maxScore: 10, minThreshold: 5 })
      assert.equal(minOnly.assess(5), 'pass')
      assert.equal(minOnly.assess(4), 'fail')
      const maxOnly = new ScoreStructuredOutput({ description: 'x', minScore: 0, maxScore: 10, maxThreshold: 5 })
      assert.equal(maxOnly.assess(5), 'pass')
      assert.equal(maxOnly.assess(6), 'fail')
      assert.equal(new ScoreStructuredOutput({ description: 'x', minScore: 0, maxScore: 10 }).assess(6), null)
    })

    it('builds the categorical schema from categories and pass values', () => {
      assert.equal(new CategoricalStructuredOutput({ categories: { a: 'A' } }).assess('a'), null)
      const output = new CategoricalStructuredOutput({ categories: { good: 'Good', bad: 'Bad' }, passValues: ['good'] })
      const schema = output.toJsonSchema()
      assert.deepEqual(schema.properties.categorical_eval.anyOf, [
        { const: 'good', description: 'Good' },
        { const: 'bad', description: 'Bad' },
      ])
      assert.equal(output.assess('good'), 'pass')
      assert.equal(output.assess('bad'), 'fail')
    })
  })

  describe('LLMJudge', () => {
    const structuredOutput = new BooleanStructuredOutput({ description: 'Correct?', passWhen: true, reasoning: true })

    it('validates constructor options', () => {
      assert.throws(() => new LLMJudge({ modelCall () {}, structuredOutput }), { message: /userPrompt/ })
      assert.throws(() => new LLMJudge({ userPrompt: 'x', structuredOutput }), { message: /modelCall/ })
      assert.throws(() => new LLMJudge({ userPrompt: 'x', modelCall () {}, structuredOutput, provider: 'nope' }), {
        message: /provider/,
      })
    })

    it('renders placeholders, calls the model function, and parses the structured response', async () => {
      const calls = []
      const judge = new LLMJudge({
        name: 'judge',
        userPrompt: 'Q: {{input_data}} A: {{output_data}} E: {{expected_output}} M: {{metadata.topic}} S: {{span_id}}',
        systemPrompt: 'You are a judge.',
        model: 'gpt-4o',
        provider: 'openai',
        modelParams: { temperature: 0 },
        structuredOutput,
        modelCall (request) {
          calls.push(request)
          return JSON.stringify({ boolean_eval: true, reasoning: 'looks right' })
        },
      })
      const result = await judge.evaluate(ctx({
        inputData: 'what is 1+1?',
        outputData: '2',
        expectedOutput: 2,
        metadata: { topic: 'math' },
      }))

      assert.equal(calls.length, 1)
      assert.equal(calls[0].provider, 'openai')
      assert.equal(calls[0].model, 'gpt-4o')
      assert.deepEqual(calls[0].modelParams, { temperature: 0 })
      assert.deepEqual(calls[0].messages, [
        { role: 'system', content: 'You are a judge.' },
        { role: 'user', content: 'Q: what is 1+1? A: 2 E: 2 M: math S: span-1' },
      ])
      assert.equal(calls[0].jsonSchema.properties.boolean_eval.type, 'boolean')

      assert.ok(result instanceof EvaluatorResult)
      assert.equal(result.value, true)
      assert.equal(result.reasoning, 'looks right')
      assert.equal(result.assessment, 'pass')
      assert.deepEqual(result.metadata, { raw_response: { boolean_eval: true, reasoning: 'looks right' } })
    })

    it('accepts already-parsed objects and async model functions', async () => {
      const judge = new LLMJudge({
        userPrompt: '{{output_data}}',
        structuredOutput: new ScoreStructuredOutput({ description: 'x', minScore: 0, maxScore: 1, minThreshold: 0.5 }),
        async modelCall () {
          return { score_eval: 0.25, reasoning: 'meh' }
        },
      })
      const result = await judge.evaluate(ctx({ outputData: 'out' }))
      assert.equal(result.value, 0.25)
      assert.equal(result.assessment, 'fail')
      assert.equal(result.reasoning, null)
    })

    it('rejects malformed model responses', async () => {
      const judge = new LLMJudge({
        userPrompt: '{{output_data}}',
        structuredOutput,
        modelCall () {
          return JSON.stringify({ boolean_eval: 'yes' })
        },
      })
      assert.throws(() => judge.evaluate(ctx({ outputData: 'out' })), { message: /Expected boolean, got string/ })
      const notJson = new LLMJudge({ userPrompt: 'x', structuredOutput, modelCall: () => 'nope' })
      assert.throws(() => notJson.evaluate(ctx()), { message: /Invalid JSON response/ })
      const array = new LLMJudge({ userPrompt: 'x', structuredOutput, modelCall: () => '[1]' })
      assert.throws(() => array.evaluate(ctx()), { message: /expected object/ })
      const rejected = new LLMJudge({ userPrompt: 'x', structuredOutput, modelCall: async () => 42 })
      await assert.rejects(rejected.evaluate(ctx()), { message: /JSON string or a plain object/ })
    })

    it('builds the publish payload expected by the custom evaluator endpoint', () => {
      const judge = new LLMJudge({
        name: 'my-judge',
        userPrompt: 'Answer: {{output_data}} for {{input_data}}',
        systemPrompt: 'Judge.',
        model: 'gpt-4o',
        provider: 'openai',
        structuredOutput,
        modelCall () {},
      })
      const payload = judge.buildPublishPayload('my-app', 'published-name', { input_data: 'question' })
      assert.equal(payload.eval_name, 'published-name')
      assert.equal(payload.applications.length, 1)
      const app = payload.applications[0]
      assert.equal(app.application_name, 'my-app')
      assert.equal(app.enabled, false)
      assert.equal(app.model_provider, 'openai')
      assert.deepEqual(app.byop_config.prompt_template, [
        { role: 'system', content: 'Judge.' },
        { role: 'user', content: 'Answer: {{output_data}} for {{question}}' },
      ])
      assert.equal(app.byop_config.parsing_type, 'structured_output')
      assert.ok(app.byop_config.output_schema)
      assert.throws(() => judge.buildPublishPayload(''), { message: /mlApp/ })
    })
  })
})
