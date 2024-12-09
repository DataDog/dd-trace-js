'use strict'

const dc = require('dc-polyfill')

// TODO: use TBD naming convention
module.exports = {
  bodyParser: dc.channel('datadog:body-parser:read:finish'),
  cookieParser: dc.channel('datadog:cookie-parser:read:finish'),
  multerParser: dc.channel('datadog:multer:read:finish'),
  startGraphqlResolve: dc.channel('datadog:graphql:resolver:start'),
  graphqlMiddlewareChannel: dc.tracingChannel('datadog:apollo:middleware'),
  apolloChannel: dc.tracingChannel('datadog:apollo:request'),
  apolloServerCoreChannel: dc.tracingChannel('datadog:apollo-server-core:request'),
  incomingHttpRequestStart: dc.channel('dd-trace:incomingHttpRequestStart:high'),
  incomingHttpRequestEnd: dc.channel('dd-trace:incomingHttpRequestEnd:high'),
  passportVerify: dc.channel('datadog:passport:verify:finish'),
  queryParser: dc.channel('datadog:query:read:finish'),
  setCookieChannel: dc.channel('datadog:iast:set-cookie'),
  nextBodyParsed: dc.channel('apm:next:body-parsed:high'),
  nextQueryParsed: dc.channel('apm:next:query-parsed:high'),
  expressProcessParams: dc.channel('datadog:express:process_params:start:high'),
  responseBody: dc.channel('datadog:express:response:json:start:high'),
  responseWriteHead: dc.channel('apm:http:server:response:writeHead:start:high'),
  httpClientRequestStart: dc.channel('apm:http:client:request:start:high'),
  responseSetHeader: dc.channel('datadog:http:server:response:set-header:start:high'),
  setUncaughtExceptionCaptureCallbackStart: dc.channel('datadog:process:setUncaughtExceptionCaptureCallback:start'),
  pgQueryStart: dc.channel('apm:pg:query:start'),
  pgPoolQueryStart: dc.channel('datadog:pg:pool:query:start'),
  mysql2OuterQueryStart: dc.channel('datadog:mysql2:outerquery:start'),
  wafRunFinished: dc.channel('datadog:waf:run:finish'),
  fsOperationStart: dc.channel('apm:fs:operation:start'),
  expressMiddlewareError: dc.channel('apm:express:middleware:error:error'),
  childProcessExecutionTracingChannel: dc.tracingChannel('datadog:child_process:execution')
}
