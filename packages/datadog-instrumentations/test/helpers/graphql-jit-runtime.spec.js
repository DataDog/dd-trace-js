'use strict'

const assert = require('node:assert/strict')

const graphql = require('graphql')

const createGraphqlJitRuntime = require('../../src/helpers/graphql-jit-runtime')

function noop () {}

const schema = graphql.buildSchema('type Query { field: String }')
const parentType = schema.getQueryType()
const field = parentType.getFields().field
const [fieldNode] = graphql.parse('{ field }').definitions[0].selectionSet.selections
const input = {
  fieldName: field.name,
  fieldNodes: [fieldNode],
  parentType,
  returnType: field.type,
}
const compiledArguments = { missing: [], values: {} }

const { configureCompilationContext, runtime } = createGraphqlJitRuntime({
  createFieldMetadata: noop,
  resolveDefaultInvocation: noop,
  startExecution: noop,
  wrapResolver: noop,
})

function createContext () {
  const context = {
    hoistedFunctions: [],
    resolvers: {},
  }
  configureCompilationContext({ result: context })
  return context
}

describe('graphql-jit runtime fallbacks', () => {
  it('does not register fields with unsupported response paths', () => {
    const context = createContext()

    assert.strictEqual(runtime.registerField(context, null, input), undefined)
    assert.strictEqual(runtime.registerField(context, 'field', input), undefined)
    assert.strictEqual(runtime.registerField(context, { key: 1, type: 'literal' }, input), undefined)
    assert.strictEqual(runtime.registerField(context, { key: 'field', type: 'unknown' }, input), undefined)
  })

  it('keeps unmatched default field source unchanged', () => {
    const compiledField = 'other.field'
    const result = runtime.compileDefaultField(
      createContext(),
      undefined,
      parentType,
      field,
      [fieldNode],
      ['source'],
      compiledArguments,
      '',
      compiledField
    )

    assert.strictEqual(result, compiledField)
  })

  it('keeps default field source unchanged for unsupported response paths', () => {
    const compiledField = 'source.field'
    const result = runtime.compileDefaultField(
      createContext(),
      null,
      parentType,
      field,
      [fieldNode],
      ['source'],
      compiledArguments,
      '',
      compiledField
    )

    assert.strictEqual(result, compiledField)
  })
})
