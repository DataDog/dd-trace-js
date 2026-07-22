'use strict'

const { DD_MAJOR } = require('../../../../version')

module.exports = {
  '@aws/durable-execution-sdk-js': [
    {
      name: '@aws/durable-execution-sdk-js-testing',
      dep: true,
      forced: true,
    },
  ],
  aerospike: [
    {
      name: 'aerospike',
      versions: ['4', '5', '>=6'],
    },
  ],
  ai: [
    {
      name: 'ai',
      versions: ['4.0.2'],
    },
    {
      name: '@ai-sdk/openai',
      versions: ['^1.3.23', '^2.0.0', '^3.0.0', '>=4.0.0'],
    },
    {
      name: '@ai-sdk/amazon-bedrock',
      versions: ['^3.0.0', '^4.0.0', '>=5.0.0'],
    },
    {
      name: '@ai-sdk/anthropic',
      versions: ['^1.0.0', '^2.0.0', '^3.0.0', '>=4.0.0'],
    },
    {
      name: '@ai-sdk/google',
      versions: ['^1.0.0', '^2.0.0', '^3.0.0', '>=4.0.0'],
    },
    {
      name: 'zod',
      versions: ['>=3.25.75'],
      // `ai@4.0.2` declares `zod` as an optional peer (`^3.0.0`) and
      // `@ai-sdk/openai@1.3.23+` declares it as a required peer. Bun's isolated
      // linker skips optional peers, so inject it into each ai sandbox.
      dep: true,
      // zod-to-json-schema@3.25.x requires the zod/v3 export absent from zod@3.23.x.
      overrides: {
        'zod-to-json-schema': '<3.25.0',
      },
    },
  ],
  apollo: [
    {
      name: '@apollo/subgraph',
      versions: ['>=2.3.0'],
    },
    {
      name: 'graphql',
      versions: ['^16.6.0'],
    },
    {
      name: 'graphql-tag',
      versions: ['^2.12.6'],
    },
    {
      name: '@apollo/server',
      versions: ['^4.0.0'],
    },
  ],
  'aws-sdk': [
    {
      name: '@aws-sdk/client-lambda',
      versions: ['>=3'],
    },
    {
      name: '@aws-sdk/client-kinesis',
      versions: ['>=3'],
    },
    {
      name: '@aws-sdk/client-s3',
      versions: ['>=3'],
    },
    {
      name: '@aws-sdk/client-dynamodb',
      versions: ['>=3'],
    },
    {
      name: '@aws-sdk/client-sfn',
      versions: ['>=3'],
    },
    {
      name: '@aws-sdk/client-sns',
      versions: ['>=3'],
    },
    {
      name: '@aws-sdk/client-sqs',
      versions: ['>=3'],
    },
    {
      name: '@aws-sdk/node-http-handler',
      versions: ['>=3'],
    },
    {
      name: '@aws-sdk/client-bedrock-runtime',
      versions: ['>=3.422.0'],
    },
  ],
  bullmq: [
    {
      name: 'redis',
      versions: ['>=4'],
    },
  ],
  'body-parser': [
    {
      name: 'express',
      versions: ['^4'],
    },
  ],
  child_process: [
    {
      name: 'bluebird',
      versions: ['^3'],
    },
  ],
  'claude-agent-sdk': [
    {
      name: 'zod',
      versions: ['^4.0.0'],
    },
  ],
  '@anthropic-ai/claude-agent-sdk': [
    {
      name: 'zod',
      version: '^4.0.0',
      dep: true,
      forced: true,
    },
  ],
  'cookie-parser': [
    {
      name: 'express',
      versions: ['^4'],
    },
  ],
  'confluentinc-kafka-javascript': [
    {
      name: 'kafkajs',
      versions: ['>=1.4.0'],
    },
  ],
  express: [
    {
      name: 'axios',
      versions: ['>=1.0.0'],
    },
    {
      name: 'loopback',
      versions: ['>=2.38.1'],
    },
    {
      name: 'cookie-parser',
      versions: ['>=1.4.6'],
    },
    {
      name: 'request',
      versions: ['2.88.2'],
    },
    {
      name: 'multer',
      versions: ['^1.4.4-lts.1'],
    },
    {
      name: 'ejs',
      versions: ['3.1.10'],
    },
  ],
  'express-mongo-sanitize': [
    {
      name: 'mongodb',
      versions: ['>=3.3 <5', '5', '6'],
    },
    {
      name: 'mongodb',
      versions: ['>=7'],
      node: '>=20.19.0',
    },
    {
      name: 'mongodb-core',
      versions: ['3.2.7'],
    },
    {
      name: 'express',
      versions: [
        '>=4 <5',
        '>=4.0.0 <4.3.0',
        '>=4.3.0 <5',
      ],
    },
    {
      name: 'body-parser',
      versions: ['1.20.1'],
    },
  ],
  'express-session': [
    {
      name: 'express',
      versions: ['>=4.0.0'],
    },
  ],
  mquery: [
    {
      name: 'express',
      versions: ['>=4', '>=4.0.0 <4.3.0', '>=4.0.0 <5.0.0', '>=4.3.0 <5.0.0'],
    },
    {
      name: 'mongodb',
      versions: ['5', '6'],
    },
    {
      name: 'mongodb',
      versions: ['>=7'],
      node: '>=20.19.0',
    },
  ],
  mysql2: [
    {
      name: 'mysql2',
      versions: ['1.3.3'],
    },
    {
      name: 'express',
      versions: ['>=4'],
    },
  ],
  fastify: [
    {
      name: 'fastify',
      versions: ['2.15.0', '3.0.0', '3.9.2'],
    },
    {
      name: 'middie',
      versions: ['5.1.0'],
    },
    {
      name: '@fastify/cookie',
      versions: ['>=6 <11.1.0'],
      node: '<22',
    },
    {
      name: '@fastify/cookie',
      versions: ['>=6'],
      node: '>=22',
    },
    {
      name: '@fastify/multipart',
      versions: ['>=6', '9.3.0'],
    },
    {
      name: 'pg',
      versions: ['8.7.3'],
    },
  ],
  'generic-pool': [
    {
      name: 'generic-pool',
      versions: ['>=3'],
    },
  ],
  'google-cloud-pubsub': [
    {
      name: 'google-gax',
      versions: ['5.0.7'],
    },
  ],
  // pubsub@1.2.0's `pubsub.js` source-requires `@grpc/grpc-js` without declaring
  // it; the parent-walk resolution can land on a different `@grpc/grpc-js`
  // instance than the one its nested google-gax@1.15.4 uses (`~1.3.6`), and the
  // credentials produced fail the `instanceof ChannelCredentials` check across
  // module instances. Force the matching range as a direct dep of every pubsub
  // sandbox so the workspace root resolves to one consistent copy.
  '@google-cloud/pubsub': [
    {
      name: '@grpc/grpc-js',
      version: '~1.3.6',
      dep: true,
      forced: true,
    },
  ],
  // The bedrock-runtime tests reach into `@smithy/node-http-handler` directly
  // through `versions/@aws-sdk/client-bedrock-runtime@*/index.js.get(...)`.
  // Under bun's isolated linker that transitive sits only inside aws-sdk's
  // private store and isn't reachable from the workspace root, so inject it
  // as a direct dep of every bedrock-runtime sandbox. The constructor and
  // `send()` API of `@smithy/node-http-handler` have been stable across v2-v4,
  // so letting bun pick the latest is enough for what the test needs.
  '@aws-sdk/client-bedrock-runtime': [
    {
      name: '@smithy/node-http-handler',
      version: '*',
      dep: true,
      forced: true,
    },
  ],
  // The vertex-ai test stubs `GoogleAuth.prototype.getAccessToken` via
  // `require('versions/@google-cloud/vertexai@<ver>').get('google-auth-library/...')`.
  // `google-auth-library` is a regular transitive of `@google-cloud/vertexai`,
  // so under bun's isolated linker it lives in vertexai's private store and
  // isn't reachable from the workspace root. Inject it as a direct dep of
  // every vertexai sandbox so the test's `getExport` lookup resolves.
  // Pin to vertexai's own `^9.0.0` range (every published version still
  // declares it) so bun dedupes the direct dep and the SDK's transitive to
  // a single physical `.bun/google-auth-library@9.x.y` entry — the prototype
  // stub only propagates to the SDK when both resolve to the same realpath.
  '@google-cloud/vertexai': [
    {
      name: 'google-auth-library',
      version: '^9.0.0',
      dep: true,
      forced: true,
    },
  ],
  genai: [
    {
      name: '@google/genai',
      versions: ['>=1.19.0'],
    },
  ],
  graphql: [
    {
      name: 'apollo-server-core',
      versions: ['1.3.6'],
    },
    {
      name: 'express',
      versions: ['>=4'],
    },
    {
      name: 'apollo-server-express',
      versions: ['>=3'],
    },
    {
      name: 'fastify',
      versions: ['>=3'],
    },
    {
      name: 'apollo-server-fastify',
      versions: ['>=3'],
    },
    {
      name: 'graphql-tools',
      versions: ['3.1.1'],
    },
    {
      name: 'graphql-yoga',
      versions: ['^3.6.0'],
    },
    {
      name: 'graphql',
      versions: ['^15.2.0'],
    },
  ],
  'apollo-server-core': [
    {
      name: 'fastify',
      versions: ['>=3'],
    },
    {
      name: 'express',
      versions: ['>=4'],
    },
    {
      name: 'apollo-server-fastify',
      versions: ['>=3'],
    },
    {
      name: 'apollo-server-express',
      versions: ['>=3'],
    },
    {
      name: 'graphql',
      versions: ['^15.2.0'],
    },
  ],
  'apollo-server': [
    {
      name: 'express',
      versions: ['>=4'],
    },
    {
      name: '@apollo/server',
      versions: ['>=4'],
    },
    {
      name: 'graphql',
      versions: ['^16.6.0'],
    },
  ],
  // These packages pass schema objects across package boundaries; GraphQL rejects objects created by another copy.
  '@apollo/gateway': [
    {
      name: 'graphql',
      dep: true,
    },
  ],
  '@apollo/server': [
    {
      // The shared apollo-server-* install also brings in graphql 15.x (for apollo-server v3), which may be
      // hoisted over the ^16.11 that @apollo/server v5 needs. Without the pin, v5 resolves 15.x, whose TypeInfo
      // lacks the `.enter`/`.leave` methods the graphql instrumentation calls, so every traced operation throws.
      name: 'graphql',
      dep: true,
    },
  ],
  '@apollo/subgraph': [
    {
      name: 'graphql',
      dep: true,
    },
  ],
  grpc: [
    {
      name: '@grpc/proto-loader',
      versions: ['0.5.0'],
    },
  ],
  hapi: [
    {
      name: '@hapi/boom',
      versions: ['9.1.4'],
    },
  ],
  hono: [
    {
      name: '@hono/node-server',
      versions: ['1.15.0'],
    },
  ],
  knex: [
    {
      name: 'sqlite3',
      versions: ['^5.0.8'],
    },
    {
      // knex 1.x is the only major whose sqlite3 dialect requires the @vscode/sqlite3 fork instead of `sqlite3`
      // (reverted in 2.x). Pin the fork so the instrumentation spec can open a sqlite3 client.
      name: '@vscode/sqlite3',
      versions: ['5.1.12-vscode'],
    },
    {
      // Bun runs @vscode/sqlite3's node-gyp script before its package-local tar dependency is available.
      name: 'tar',
      version: '7.5.4',
      dep: true,
      forced: true,
    },
    {
      name: 'pg',
      versions: [
        '8.7.3',
      ],
    },
  ],
  koa: [
    {
      name: 'koa-route',
      versions: ['>=3.2'],
    },
    {
      name: 'koa-websocket',
      versions: ['5.0.1'],
    },
    {
      name: 'ws',
      versions: ['6.1.0'],
    },
  ],
  langchain: [
    {
      name: '@langchain/anthropic',
      versions: ['>=0.1'],
    },
    {
      name: '@langchain/google-genai',
      versions: ['>=0.1'],
    },
    {
      name: '@langchain/cohere',
      versions: ['>=0.1'],
    },
    {
      name: 'langchain',
      versions: ['>=0.1'],
    },
    {
      name: '@langchain/classic',
      versions: ['>=1.0'],
    },
    {
      name: '@langchain/core',
      versions: ['>=0.1'],
      dep: true,
    },
    {
      // The recorded cassettes match the OpenAI/JS 4.x request shape.
      name: '@langchain/openai',
      version: '0.0.34',
      dep: true,
      forced: true,
      overrides: {
        '@langchain/openai@0.0.34/@langchain/core': '^0.2.0',
      },
    },
  ],
  langgraph: [
    {
      name: '@langchain/langgraph',
      versions: ['>=1.1.2'],
    },
    {
      name: '@langchain/core',
      versions: ['>=1.1.16'],
      dep: true,
    },
    {
      name: 'zod',
      versions: ['>=3.25.32'],
      dep: true,
    },
    {
      name: 'zod-to-json-schema',
      versions: ['>=3.0.0'],
      dep: true,
    },
  ],
  ldapjs: [
    {
      name: 'ldapjs',
      versions: ['>= 2'],
    },
    {
      name: 'ldapjs-promise',
      versions: ['>=2'],
    },
  ],
  'light-my-request': [
    {
      name: 'fastify',
      versions: ['>=3'],
    },
  ],
  'limitd-client': [
    {
      name: 'hashlru',
      // limitd-protocol@2.1.1 uses an unprefixed GitHub shorthand that Bun cannot resolve.
      overrides: {
        hashlru: 'github:jfromaniello/hashlru#return_value_on_set',
      },
    },
  ],
  mariadb: [
    {
      name: 'mariadb',
      versions: ['2.5.6', '3.0.0', '3.4.0'],
    },
  ],
  mercurius: [
    {
      // mercurius peers graphql; pin the only supported major (16) so the
      // graphql instrumentation's TypeInfo `.enter`/`.leave` calls resolve.
      name: 'graphql',
      versions: ['^16.0.0'],
    },
    {
      // mercurius <=14 needs fastify 4 (fastify-plugin ^4), 15+ needs fastify 5
      // (fastify-plugin ^5). Install both majors; the peer-dependency patcher
      // picks the one each mercurius version folder accepts.
      name: 'fastify',
      versions: ['>=4'],
    },
  ],
  mocha: [
    {
      name: 'mocha',
      versions: DD_MAJOR >= 6 ? ['>=8.0.0'] : ['>=5.2.0', '>=8.0.0'],
    },
    {
      name: 'mocha-each',
      versions: ['>=2.0.1'],
    },
  ],
  modelcontextprotocol_sdk: [
    {
      name: '@modelcontextprotocol/sdk',
      versions: ['>=1.27.1'],
    },
  ],
  moleculer: [
    {
      // bluebird is a runtime fallback in moleculer's transit/util layer; the
      // package's manifest does not list it, so inject it as a direct dep of
      // each moleculer sandbox via `dep: true, forced: true`. Under bun's
      // isolated linker that lands bluebird at
      // `versions/moleculer@<ver>/node_modules/bluebird`, where moleculer's
      // require() walk from the central .bun store finds it.
      name: 'bluebird',
      versions: ['3.7.2'],
      dep: true,
      forced: true,
    },
  ],
  'mongodb-core': [
    {
      name: 'bson',
      versions: ['4.0.0'],
    },
    {
      name: 'mongodb',
      versions: ['6.3.0'],
    },
  ],
  mongoose: [
    {
      name: 'mongodb-core',
      versions: ['3.2.7'],
    },
    {
      name: 'express',
      versions: ['>=4', '>=4.0.0 <4.3.0', '>=4.0.0 <5.0.0', '>=4.3.0 <5.0.0'],
    },
    {
      name: 'body-parser',
      versions: ['1.20.1'],
    },
  ],
  multer: [
    {
      name: 'express',
      versions: ['^4'],
    },
  ],
  next: [
    {
      name: 'react',
      dep: true,
    },
    {
      name: 'react-dom',
      dep: true,
    },
  ],
  passport: [
    {
      name: 'express',
      versions: ['>=4.0.0'],
    },
    {
      name: 'express-session',
      versions: ['>=1.5.0'],
    },
    {
      name: 'passport-local',
      versions: ['>=1.0.0'],
    },
  ],
  'passport-http': [
    {
      name: 'passport',
      versions: ['>=0.4.1'],
    },
    {
      name: 'express',
      versions: ['>=4.16.2'],
    },
  ],
  'passport-local': [
    {
      name: 'passport',
      versions: ['>=0.4.1'],
    },
    {
      name: 'express',
      versions: ['>=4.16.2'],
    },
    {
      name: 'body-parser',
      versions: ['1.20.1'],
    },
  ],
  pg: [
    {
      name: 'pg-native',
      versions: ['3.0.0'],
      trustedDependencies: ['libpq'],
    },
    {
      name: 'express',
      versions: ['>=4'],
    },
    {
      name: 'pg-query-stream',
      versions: ['>=4'],
    },
    {
      name: 'pg-cursor',
      versions: ['>=2'],
    },
  ],
  pino: [
    {
      name: 'pino-pretty',
      dep: true,
      versions: ['8.0.0'],
    },
  ],
  '@prisma/client': [
    {
      name: 'prisma',
      dep: '@prisma/client',
    },
    {
      name: 'typescript',
      dep: true,
      versions: ['>=5.4.0'],
    },
    {
      name: '@prisma/adapter-pg',
      dep: true,
      node: '>=20',
    },
    {
      name: '@prisma/adapter-mariadb',
      dep: true,
      node: '>=20',
    },
    {
      name: '@prisma/adapter-mssql',
      dep: true,
      node: '>=20',
    },
    {
      name: 'mongodb',
      dep: true,
      forced: true,
      node: '>=20.19.0',
    },
    {
      name: 'mongodb-core',
      dep: true,
      forced: true,
    },
    {
      name: 'tedious',
      dep: true,
      forced: true,
    },
  ],
  q: [
    {
      name: 'collections',
      versions: ['5'],
      // q@2 requires collections/shim, which is absent from its declared collections@^2.
      overrides: {
        collections: '^5.0.0',
      },
    },
    {
      name: 'q',
      versions: ['2'],
    },
  ],
  redis: [
    {
      name: 'redis',
      versions: ['^4'],
    },
  ],
  rhea: [
    {
      name: 'amqp10',
      versions: ['^3'],
    },
  ],
  sequelize: [
    {
      name: 'express',
      versions: ['>=4'],
    },
    {
      name: 'mysql2',
      dep: true,
    },
    {
      name: 'sqlite3',
      versions: ['^5.0.8'],
    },
  ],
  stripe: [
    {
      name: 'stripe',
      versions: ['9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '>=20.0.0 <22'],
    },
    {
      name: 'express',
      versions: ['^4'],
    },
    {
      name: 'body-parser',
      versions: ['1.20.1'],
    },
  ],
}
