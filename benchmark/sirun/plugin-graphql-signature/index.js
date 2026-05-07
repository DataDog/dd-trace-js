'use strict'

const assert = require('node:assert/strict')

// `defaultEngineReportingSignature` reads its graphql primitives from
// `globalThis[Symbol.for('dd-trace')]`, which the production instrumentation
// populates via `addHook` callbacks. The bench wires them in directly so the
// hot loop never touches the instrumentation layer.
const graphql = require('graphql')
const visitor = require('graphql/language/visitor')
const printer = require('graphql/language/printer')
const utilities = require('graphql/utilities')
const ddGlobal = globalThis[Symbol.for('dd-trace')] = globalThis[Symbol.for('dd-trace')] || {}
ddGlobal.graphql_visitor = visitor
ddGlobal.graphql_printer = printer
ddGlobal.graphql_utilities = utilities

const { defaultEngineReportingSignature } =
  require('../../../packages/datadog-plugin-graphql/src/tools/signature')

const { VARIANT } = process.env

const ITERATIONS = 70_000

// A small bag of realistic queries: short / medium / long, with literals,
// aliases, variables, fragments, and a deeper selection set. Apollo / Yoga
// / Mercurius typically see ~5-15 distinct document shapes per service.
const QUERIES = [
  // 0: short, no variables
  '{ user(id: 1) { id name email } }',
  // 1: with variables and aliases
  `query GetUser($id: ID!) {
    me: user(id: $id) {
      id
      displayName: name
      email
    }
  }`,
  // 2: nested selection + numeric / string literals
  `query Pets {
    user(id: 42) {
      pets(limit: 10, kind: "dog") {
        id
        name
        breed
      }
    }
  }`,
  // 3: fragments
  `fragment UserParts on User { id name email }
   query Q { user(id: 1) { ...UserParts } }`,
  // 4: multi-operation document, exercises separateOperations + dropUnusedDefinitions
  `query A { a: ping }
   query B { b: ping }
   query C { c: ping }`,
  // 5: deeper selection
  `query Deep {
    org(slug: "acme") {
      teams(limit: 5) {
        members(role: "admin") {
          user {
            profile { id displayName avatarUrl }
          }
        }
      }
    }
  }`,
  // 6: list values + object values (exercise the consolidated visitor's
  // ListValue / ObjectValue branches that hideLiterals collapses)
  '{ search(filters: { ids: [1, 2, 3], tags: ["a", "b"] }, limit: 5) { id } }',
  // 7: directives
  `query Conditional($skipName: Boolean!) {
    user(id: 1) {
      id
      name @skip(if: $skipName)
    }
  }`,
]

// Pre-parse every document once at module top-level so the per-iteration cost
// is signature work only, not parse work.
const PARSED = QUERIES.map(src => graphql.parse(src))
const OPERATION_NAMES = [undefined, 'GetUser', 'Pets', 'Q', 'A', 'Deep', undefined, 'Conditional']

// Pre-flight: confirm the signature pipeline produces a non-empty string for
// every input shape; catches a silent breakage where the global wiring or one
// of the realistic queries no longer round-trips.
for (let i = 0; i < PARSED.length; i++) {
  const sig = defaultEngineReportingSignature(PARSED[i], OPERATION_NAMES[i])
  assert.ok(typeof sig === 'string' && sig.length > 0,
    `signature for query ${i} was not a non-empty string`)
}

if (VARIANT === 'same-document') {
  // Repeatedly sign the same parsed document — maximum hit rate for any
  // future memoization, baseline for the current unconsolidated pipeline.
  const ast = PARSED[1]
  const op = OPERATION_NAMES[1]
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    defaultEngineReportingSignature(ast, op)
  }
} else if (VARIANT === 'rotating-documents') {
  // Rotate through eight realistic documents — mimics a multi-endpoint
  // service handing distinct queries from its own document cache.
  const len = PARSED.length
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const i = iteration % len
    defaultEngineReportingSignature(PARSED[i], OPERATION_NAMES[i])
  }
}
