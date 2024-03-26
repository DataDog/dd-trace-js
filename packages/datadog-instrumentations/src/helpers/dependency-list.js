'use strict'

module.exports = new Map([
  ['@apollo/server', [
    '/dist/cjs/ApolloServer.js',
    '/dist/cjs/express4/index.js',
    '/dist/cjs/utils/HeaderMap.js'
  ]],
  ['@apollo/gateway', [
    '/dist/utilities/opentelemetry.js',
    '/dist/utilities/opentelemetry.js',
    ''
  ]],
  ['apollo-server-core', ['/dist/runHttpQuery.js']],
  ['@smithy/smithy-client', ['']],
  ['@aws-sdk/smithy-client', ['']],
  ['aws-sdk', [
    '',
    '/lib/core.js'
  ]],
  ['@cucumber/cucumber', [
    '/lib/runtime/pickle_runner.js',
    '/lib/runtime/test_case_runner.js',
    '/lib/runtime/index.js'
  ]],
  ['@playwright/test', [
    '/lib/runner.js',
    '/lib/dispatcher.js',
    '/lib/runner/dispatcher.js',
    '/lib/runner/runner.js'
  ]],
  ['playwright', [
    '/lib/runner/runner.js',
    '/lib/runner/dispatcher.js',
    '/lib/common/suiteUtils.js',
    '/lib/runner/loadUtils.js'
  ]],
  ['@elastic/transport', ['/lib/Transport.js']],
  ['@elastic/elasticsearch', ['/lib/Transport.js']],
  ['elasticsearch', [
    '/src/lib/transport.js',
    '/src/lib/connection_pool.js'
  ]],
  ['@google-cloud/pubsub', ['', '/build/src/lease-manager.js']],
  ['@graphql-tools/executor', ['/cjs/execution/execute.js']],
  ['graphql', [
    '/execution/execute.js',
    '/language/parser.js',
    '/validation/validate.js'
  ]],
  ['@hapi/hapi', [
    '',
    '/lib/core.js',
    '/lib/route.js'
  ]],
  ['hapi', [
    '',
    '/lib/connection.js',
    '/lib/core.js',
    '/lib/route.js'
  ]],
  ['jest-environment-node', ['']],
  ['jest-environment-jsdom', ['']],
  ['@jest/core', ['/build/TestScheduler.js']],
  ['@jest/test-sequencer', ['']],
  ['@jest/reporters', [
    '/build/coverage_reporter.js',
    '/build/CoverageReporter.js'
  ]],
  ['@jest/core', [
    '/build/cli/index.js',
    '/build/SearchSource.js'
  ]],
  ['jest-circus', ['/build/legacy-code-todo-rewrite/jestAdapter.js']],
  ['@jest/transform', ['/build/ScriptTransformer.js']],
  ['jest-config', ['']],
  ['jest-jasmine2', ['/build/jasmineAsyncInstall.js']],
  ['jest-worker', ['/build/workers/ChildProcessWorker.js']],
  ['koa', ['']],
  ['@koa/router', ['']],
  ['koa-router', ['']],
  ['@node-redis/client', [
    '/dist/lib/client/commands-queue.js',
    '/dist/lib/client/index.js'
  ]],
  ['@redis/client', [
    '/dist/lib/client/index.js',
    '/dist/lib/client/commands-queue.js'
  ]],
  ['redis', ['']],
  ['@opensearch-project/opensearch', ['/lib/Transport.js']],
  ['@opentelemetry/sdk-trace-node', ['/build/src/NodeTracerProvider.js']],
  ['aerospike', ['/lib/commands/command.js']],
  ['amqp10', [
    '/lib/sender_link.js',
    '/lib/receiver_link.js'
  ]],
  ['amqplib', [
    '/lib/defs.js',
    '/lib/channel.js'
  ]],
  ['bluebird', ['']],
  ['body-parser', ['/lib/read.js']],
  ['bunyan', ['']],
  ['cassandra-driver', [
    '',
    '/lib/request-execution.js',
    '/lib/request-handler.js'
  ]],
  ['child_process', ['']],
  ['node:child_process', ['']],
  ['connect', ['']],
  ['cookie', ['']],
  ['cookie-parser', ['']],
  ['couchbase', [
    '/lib/bucket.js',
    '/lib/cluster.js',
    '/lib/collection.js',
    '/dist/collection.js',
    '/dist/bucket.js',
    '/dist/cluster.js'
  ]],
  ['crypto', ['']],
  ['node:crypto', ['']],
  ['cypress', ['']],
  ['dns', ['']],
  ['node:dns', ['']],
  ['express', [
    '',
    '/lib/middleware/query.js'
  ]],
  ['express-mongo-sanitize', ['']],
  ['fastify', ['']],
  ['find-my-way', ['']],
  ['fs', ['']],
  ['node:fs', ['']],
  ['generic-pool', ['']],
  ['@graphql-tools/executor', ['/cjs/execution/execute.js']],
  ['graphql', [
    '/execution/execute.js',
    '/language/parser.js',
    '/validation/validate.js'
  ]],
  ['ioredis', ['']],
  ['knex', [
    '/lib/query/builder.js',
    '/lib/raw.js',
    '/lib/schema/builder.js',
    '/lib/knex-builder/Knex.js'
  ]],
  ['kafkajs', ['/src/index.js']],
  ['ldapjs', ['']],
  ['limitd-client', ['']],
  ['mariadb', [
    '/lib/cmd/query.js',
    '/lib/cmd/execute.js',
    '/lib/pool.js',
    '/lib/connection.js',
    '/lib/pool-base.js'
  ]],
  ['memcached', ['']],
  ['microgateway-core', [
    '/lib/config-proxy-middleware.js',
    '/lib/plugins-middleware.js'
  ]],
  ['mocha', [
    '/lib/mocha.js',
    '/lib/suite.js',
    '/lib/runner.js',
    '/lib/cli/run-helpers.js',
    '/lib/runnable.js'
  ]],
  ['mocha-each', ['']],
  ['mongodb', [
    '',
    '/lib/cmap/connection.js',
    '/lib/core/wireprotocol/index.js',
    '/lib/utils.js'
  ]],
  ['mongodb-core', [
    '',
    '/lib/wireprotocol/index.js',
    '/lib/wireprotocol/3_2_support.js',
    '/lib/wireprotocol/2_6_support.js'
  ]],
  ['mongoose', [
    '',
    '/lib/model.js',
    '/lib/helpers/query/sanitizeFilter.js'
  ]],
  ['mquery', ['']],
  ['mysql2', ['/lib/connection.js']],
  ['net', ['']],
  ['node:net', ['']],
  ['next', [
    '/dist/server/web/spec-extension/adapters/next-request.js',
    '/dist/server/serve-static.js',
    '/dist/next-server/server/serve-static.js',
    '/dist/server/next-server.js',
    '/dist/next-server/server/next-server.js',
    '/dist/server/web/spec-extension/request.js'
  ]],
  ['child_process', ['']],
  ['node:child_process', ['']],
  ['oracledb', ['']],
  ['openai', ['/dist/api.js']],
  ['paperplane', [
    '/lib/logger.js',
    '/lib/mount.js',
    '/lib/routes.js',
    ''
  ]],
  ['passport-http', ['/lib/passport-http/strategies/basic.js']],
  ['passport-local', ['/lib/strategy.js']],
  ['pg', [
    '',
    '/lib/native/index.js'
  ]],
  ['pino', ['']],
  ['pino-pretty', [
    '',
    '/lib/utils.js'
  ]],
  ['@playwright/test', [
    '/lib/runner.js',
    '/lib/dispatcher.js',
    '/lib/runner/dispatcher.js',
    '/lib/runner/runner.js'
  ]],
  ['playwright', [
    '/lib/runner/runner.js',
    '/lib/runner/dispatcher.js',
    '/lib/common/suiteUtils.js',
    '/lib/runner/loadUtils.js'
  ]],
  ['promise-js', ['']],
  ['promise', ['/lib/core.js']],
  ['q', ['']],
  ['qs', ['']],
  ['@node-redis/client', [
    '/dist/lib/client/commands-queue.js',
    '/dist/lib/client/index.js'
  ]],
  ['@redis/client', [
    '/dist/lib/client/index.js',
    '/dist/lib/client/commands-queue.js'
  ]],
  ['redis', ['']],
  ['restify', ['/lib/server.js']],
  ['rhea', [
    '',
    '/lib/link.js',
    '/lib/connection.js',
    '/lib/session.js'
  ]],
  ['router', ['']],
  ['sharedb', ['/lib/agent.js']],
  ['sequelize', ['']],
  ['tedious', ['']],
  ['when', ['/lib/Promise.js']],
  ['winston', ['/lib/winston/logger.js']]
])
