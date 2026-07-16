'use strict'

// Mercurius funnels every GraphQL request through the named async function
// `fastifyGraphQl` (decorated as both `app.graphql` and, via `reply.graphql`,
// the per-request entry point). Wrapping that one function gives a single
// top-level span per operation regardless of how the query reaches mercurius
// — HTTP POST/GET, batched queries, or a programmatic `app.graphql()` call —
// and regardless of whether the query runs through graphql's `execute` (cold)
// or a JIT-compiled query (warm), where no `graphql.execute` span fires.
//
// The function name and signature `(source, context, variables, operationName)`
// are stable across the supported major range (verified against 10.x and 16.x),
// so a `functionName` match needs no per-version file paths.
module.exports = [
  {
    module: {
      // Floor at 13: it is the oldest major whose fastify-plugin peer (^4)
      // accepts fastify 4, which installs and runs on the oldest supported Node
      // (18). 15+ requires Node 20 and fastify 5, covered on the latest-Node CI
      // leg. The `fastifyGraphQl` funnel is unchanged across this whole range.
      name: 'mercurius',
      versionRange: '>=13',
      filePath: 'index.js',
    },
    functionQuery: {
      functionName: 'fastifyGraphQl',
      kind: 'Async',
    },
    channelName: 'apm:graphql:request',
  },
]
