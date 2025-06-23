'use strict'

const dc = require('dc-polyfill')

// TODO: use TBD naming convention
module.exports = {
  apolloChannel: dc.tracingChannel('datadog:apollo:request'),
  apolloServerCoreChannel: dc.tracingChannel('datadog:apollo-server-core:request'),
  bodyParser: dc.channel('datadog:body-parser:read:finish'),
  childProcessExecutionTracingChannel: dc.tracingChannel('datadog:child_process:execution'),
  cookieParser: dc.channel('datadog:cookie-parser:read:finish'),
  expressMiddlewareError: dc.channel('apm:express:middleware:error'),
  expressProcessParams: dc.channel('datadog:express:process_params:start'),
  expressSession: dc.channel('datadog:express-session:middleware:finish'),
  fastifyBodyParser: dc.channel('datadog:fastify:body-parser:finish'),
  fastifyResponseChannel: dc.channel('datadog:fastify:response:finish'),
  fastifyQueryParams: dc.channel('datadog:fastify:query-params:finish'),
  fastifyPathParams: dc.channel('datadog:fastify:path-params:finish'),
  fsOperationStart: dc.channel('apm:fs:operation:start'),
  graphqlMiddlewareChannel: dc.tracingChannel('datadog:apollo:middleware'),
  httpClientRequestStart: dc.channel('apm:http:client:request:start'),
  incomingHttpRequestEnd: dc.channel('dd-trace:incomingHttpRequestEnd'),
  incomingHttpRequestStart: dc.channel('dd-trace:incomingHttpRequestStart'),
  multerParser: dc.channel('datadog:multer:read:finish'),
  mysql2OuterQueryStart: dc.channel('datadog:mysql2:outerquery:start'),
  nextBodyParsed: dc.channel('apm:next:body-parsed'),
  nextQueryParsed: dc.channel('apm:next:query-parsed'),
  passportUser: dc.channel('datadog:passport:deserializeUser:finish'),
  passportVerify: dc.channel('datadog:passport:verify:finish'),
  pgPoolQueryStart: dc.channel('datadog:pg:pool:query:start'),
  pgQueryStart: dc.channel('apm:pg:query:start'),
  queryParser: dc.channel('datadog:query:read:finish'),
  responseBody: dc.channel('datadog:express:response:json:start'),
  responseSetHeader: dc.channel('datadog:http:server:response:set-header:start'),
  responseWriteHead: dc.channel('apm:http:server:response:writeHead:start'),
  routerParam: dc.channel('datadog:router:param:start'),
  setCookieChannel: dc.channel('datadog:iast:set-cookie'),
  setUncaughtExceptionCaptureCallbackStart: dc.channel('datadog:process:setUncaughtExceptionCaptureCallback:start'),
  startGraphqlResolve: dc.channel('datadog:graphql:resolver:start'),
  wafRunFinished: dc.channel('datadog:waf:run:finish')
}
