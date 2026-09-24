'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const {
  BaseEvaluator,
  EvaluatorContext,
  EvaluatorResult,
  MultiEvaluatorResult,
  SummaryEvaluatorContext,
} = require('../../../src/llmobs/experiments/evaluator')
const {
  JSONEvaluator,
  LengthEvaluator,
  RegexMatchEvaluator,
  SemanticSimilarityEvaluator,
  StringCheckEvaluator,
} = require('../../../src/llmobs/experiments/builtins')
const {
  BooleanStructuredOutput,
  CategoricalStructuredOutput,
  LLMJudge,
  ScoreStructuredOutput,
} = require('../../../src/llmobs/experiments/llm-judge')

function context (outputData, expectedOutput = undefined) {
  return new EvaluatorContext({
    inputData: { prompt: 'input' },
    outputData,
    expectedOutput,
    metadata: { source: 'test' },
    spanId: 'span-id',
    traceId: 'trace-id',
  })
}

describe('LLMObs built-in experiment evaluators', () => {
  it('validates output length by characters, words, and lines', () => {
    const characters = new LengthEvaluator({ minLength: 3, maxLength: 5 })
    assert.deepEqual(characters.evaluate(context('test')), new EvaluatorResult(true, { assessment: 'pass' }))
    assert.equal(characters.evaluate(context('testing')).value, false)

    const words = new LengthEvaluator({ minLength: 2, maxLength: 2, countType: 'words' })
    assert.equal(words.evaluate(context('one two')).value, true)
    assert.equal(words.evaluate(context('one')).value, false)

    const lines = new LengthEvaluator({ minLength: 2, countType: 'lines' })
    assert.equal(lines.evaluate(context('one\ntwo')).value, true)
    assert.equal(lines.evaluate(context('one')).value, false)

    const extracted = new LengthEvaluator({
      maxLength: 4,
      outputExtractor: output => output.answer,
    })
    assert.equal(extracted.evaluate(context({ answer: 'okay' })).value, true)
    assert.throws(() => new LengthEvaluator({}), /At least one/)
    assert.throws(() => new LengthEvaluator({ minLength: 2, maxLength: 1 }), /cannot be greater/)
  })

  it('validates JSON output and required keys', () => {
    const evaluator = new JSONEvaluator({ requiredKeys: ['answer'] })
    assert.equal(evaluator.evaluate(context('{"answer":"yes"}')).value, true)
    assert.equal(evaluator.evaluate(context('{"other":"yes"}')).value, false)
    assert.equal(evaluator.evaluate(context('not-json')).value, false)
    assert.equal(evaluator.evaluate(context({ answer: 'yes' })).value, true)
    assert.equal(new JSONEvaluator().evaluate(context(null)).value, false)
  })

  it('supports string equality, containment, extraction, and null values', () => {
    assert.equal(new StringCheckEvaluator().evaluate(context('yes', 'yes')).value, true)
    assert.equal(new StringCheckEvaluator({ operation: 'ne' }).evaluate(context('yes', 'no')).value, true)
    assert.equal(new StringCheckEvaluator({ operation: 'contains' }).evaluate(context('yes indeed', 'yes')).value, true)
    assert.equal(new StringCheckEvaluator({ operation: 'icontains' }).evaluate(context('YES', 'yes')).value, true)
    assert.equal(new StringCheckEvaluator({ stripWhitespace: true }).evaluate(context(' yes ', 'yes')).value, true)
    assert.equal(new StringCheckEvaluator().evaluate(context(null, null)).value, true)
    assert.equal(new StringCheckEvaluator({ operation: 'ne' }).evaluate(context(null, 'yes')).value, true)
    assert.equal(new StringCheckEvaluator({
      outputExtractor: output => output.answer,
      expectedOutputExtractor: output => output.answer,
    }).evaluate(context({ answer: 'yes' }, { answer: 'yes' })).value, true)
    assert.throws(() => new StringCheckEvaluator({ operation: 'invalid' }), /operation must be one of/)
  })

  it('supports regex search, match, fullmatch, and flags', () => {
    assert.equal(new RegexMatchEvaluator({ pattern: '\\d+' }).evaluate(context('id=123')).value, true)
    assert.equal(
      new RegexMatchEvaluator({ pattern: '^hello', matchMode: 'match' }).evaluate(context('hello world')).value,
      true
    )
    assert.equal(
      new RegexMatchEvaluator({ pattern: 'hello', matchMode: 'fullmatch' }).evaluate(context('hello')).value,
      true
    )
    assert.equal(new RegexMatchEvaluator({ pattern: '^hello$', flags: 'i' }).evaluate(context('HELLO')).value, true)
    assert.equal(new RegexMatchEvaluator({ pattern: 'yes', outputExtractor: output => output.answer })
      .evaluate(context({ answer: 'yes' })).value, true)
    assert.equal(new RegexMatchEvaluator({ pattern: 'yes' }).evaluate(context(null)).value, false)
    assert.throws(() => new RegexMatchEvaluator({ pattern: '[', matchMode: 'search' }), /Invalid regex pattern/)
  })

  it('calculates semantic similarity with synchronous and asynchronous embeddings', async () => {
    const embeddings = {
      hello: [1, 0],
      world: [1, 0],
      other: [0, 1],
    }
    const evaluator = new SemanticSimilarityEvaluator({
      embeddingFn: text => embeddings[text],
      threshold: 0.9,
    })
    assert.equal(evaluator.evaluate(context('hello', 'world')).value, 1)
    assert.equal(evaluator.evaluate(context('hello', 'other')).value, 0.5)
    assert.equal(new SemanticSimilarityEvaluator({
      embeddingFn: () => [1, 0],
    }).evaluate(context(null, null)).value, 1)

    const asyncEvaluator = new SemanticSimilarityEvaluator({
      embeddingFn: async text => embeddings[text],
    })
    assert.equal((await asyncEvaluator.evaluate(context('hello', 'world'))).value, 1)
    assert.throws(() => new SemanticSimilarityEvaluator({ embeddingFn: () => [1], threshold: 2 }), /between 0 and 1/)
  })

  it('provides structured output schemas and parses LLM judge results', async () => {
    const booleanOutput = new BooleanStructuredOutput({
      description: 'Whether the answer is correct',
      reasoning: true,
      passWhen: true,
    })
    assert.deepEqual(booleanOutput.toJsonSchema(), {
      type: 'object',
      properties: {
        boolean_eval: { type: 'boolean', description: 'Whether the answer is correct' },
        reasoning: { type: 'string', description: 'Explanation for the evaluation result' },
      },
      required: ['boolean_eval', 'reasoning'],
      additionalProperties: false,
    })

    const calls = []
    const judge = new LLMJudge({
      name: 'correctness_judge',
      model: 'test-model',
      systemPrompt: 'You are a judge.',
      userPrompt: 'Check {{output_data.answer}} against {{expected_output}} from {{metadata.source}}.',
      structuredOutput: booleanOutput,
      client: (provider, messages, jsonSchema, model) => {
        calls.push({ provider, messages, jsonSchema, model })
        return JSON.stringify({ boolean_eval: true, reasoning: 'It matches.' })
      },
    })

    const result = await judge.evaluate(new EvaluatorContext({
      inputData: { question: 'q' },
      outputData: { answer: 'yes' },
      expectedOutput: 'yes',
      metadata: { source: 'test' },
    }))
    assert.equal(result.value, true)
    assert.equal(result.reasoning, 'It matches.')
    assert.equal(result.assessment, 'pass')
    assert.deepEqual(result.metadata, { rawResponse: { boolean_eval: true, reasoning: 'It matches.' } })
    assert.deepEqual(calls[0].messages, [
      { role: 'system', content: 'You are a judge.' },
      { role: 'user', content: 'Check yes against yes from test.' },
    ])
    assert.deepEqual(calls[0].jsonSchema, booleanOutput.toJsonSchema())
    assert.equal(calls[0].model, 'test-model')
  })

  it('supports score, categorical, custom JSON, and unstructured LLM judge results', async () => {
    const scoreJudge = new LLMJudge({
      model: 'test-model',
      userPrompt: 'Score this.',
      structuredOutput: new ScoreStructuredOutput({
        description: 'Quality',
        minScore: 0,
        maxScore: 1,
        minThreshold: 0.7,
      }),
      client: () => JSON.stringify({ score_eval: 0.7 }),
    })
    assert.equal((await scoreJudge.evaluate(context('answer'))).assessment, 'pass')

    const categoryJudge = new LLMJudge({
      model: 'test-model',
      userPrompt: 'Classify this.',
      structuredOutput: new CategoricalStructuredOutput({
        categories: { good: 'Good answer', bad: 'Bad answer' },
        passValues: ['good'],
      }),
      client: () => JSON.stringify({ categorical_eval: 'bad' }),
    })
    assert.equal((await categoryJudge.evaluate(context('answer'))).assessment, 'fail')

    const customJudge = new LLMJudge({
      model: 'test-model',
      userPrompt: 'Return JSON.',
      structuredOutput: { type: 'object' },
      client: () => JSON.stringify({ score: 3 }),
    })
    assert.deepEqual((await customJudge.evaluate(context('answer'))).value, { score: 3 })

    const rawJudge = new LLMJudge({
      model: 'test-model',
      userPrompt: 'Return text.',
      client: () => 'pass',
    })
    assert.equal(await rawJudge.evaluate(context('answer')), 'pass')

    const invalidJudge = new LLMJudge({ userPrompt: 'test', client: () => '' })
    assert.throws(() => invalidJudge.evaluate(context('answer')), /model must be specified/)
  })

  it('rejects invalid class evaluator results and names', () => {
    assert.ok(new BaseEvaluator('valid_name'))
    assert.throws(() => new BaseEvaluator('bad name'), /invalid/)
    assert.throws(() => new MultiEvaluatorResult({}), /non-empty/)
    assert.throws(() => new MultiEvaluatorResult({ 'bad name': true }), /invalid/)
    assert.ok(new SummaryEvaluatorContext({
      inputs: [],
      outputs: [],
      expectedOutputs: [],
      evaluationResults: {},
    }))
  })
})
