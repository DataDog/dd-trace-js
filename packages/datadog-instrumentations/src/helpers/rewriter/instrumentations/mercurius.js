'use strict'

// Mercurius funnels every GraphQL request through the named async function
// `fastifyGraphQl` (decorated as both `app.graphql` and, via `reply.graphql`,
// the per-request entry point). Wrapping that one function gives a single
// top-level span per operation regardless of how the query reaches mercurius
// — HTTP POST/GET, batched queries, or a programmatic `app.graphql()` call —
// and regardless of whether the query runs through graphql's `execute` or its
// JIT-compiled equivalent.
//
// The function name and signature `(source, context, variables, operationName)`
// are stable across the supported major range (verified against 13.x and 16.x),
// so a `functionName` match needs no per-version file paths.
const FASTIFY_GRAPHQL_CONTEXT = 'FunctionDeclaration[id.name="fastifyGraphQl"]:has(Identifier[name="opts"]) ' +
  'VariableDeclarator[id.name="__apm$ctx"] > ObjectExpression'
const moduleDefinition = {
  // Floor at 13: it is the oldest major whose fastify-plugin peer (^4)
  // accepts fastify 4, which installs and runs on the oldest supported Node
  // (18). 15+ requires Node 20 and fastify 5, covered on the latest-Node CI
  // leg. The `fastifyGraphQl` funnel is unchanged across this whole range.
  name: 'mercurius',
  versionRange: '>=13',
  filePath: 'index.js',
}

module.exports = [
  {
    module: moduleDefinition,
    functionQuery: {
      functionName: 'fastifyGraphQl',
      kind: 'Async',
    },
    channelName: 'apm:graphql:request',
  },
  {
    module: moduleDefinition,
    astQuery: FASTIFY_GRAPHQL_CONTEXT,
    transform: 'configureMercuriusRequest',
    channelName: 'apm:graphql:request',
  },
  {
    module: moduleDefinition,
    functionQuery: {
      functionName: 'fastifyGraphQl',
    },
    transform: 'configureGraphqlFastPath',
    channelName: 'apm:graphql:request',
  },
]
