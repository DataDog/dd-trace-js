'use strict'

module.exports = {
  HTTP_INCOMING_BODY: 'server.request.body',
  HTTP_INCOMING_QUERY: 'server.request.query',
  HTTP_INCOMING_HEADERS: 'server.request.headers.no_cookies',
  // TODO: 'server.request.trailers',
  HTTP_INCOMING_URL: 'server.request.uri.raw',
  HTTP_INCOMING_METHOD: 'server.request.method',
  HTTP_INCOMING_PARAMS: 'server.request.path_params',
  HTTP_INCOMING_COOKIES: 'server.request.cookies',
  HTTP_INCOMING_RESPONSE_CODE: 'server.response.status',
  HTTP_INCOMING_RESPONSE_HEADERS: 'server.response.headers.no_cookies',
  // TODO: 'server.response.trailers',
  HTTP_INCOMING_GRAPHQL_RESOLVERS: 'graphql.server.all_resolvers',
  HTTP_INCOMING_GRAPHQL_RESOLVER: 'graphql.server.resolver',

  HTTP_INCOMING_RESPONSE_BODY: 'server.response.body',

  HTTP_CLIENT_IP: 'http.client_ip',

  USER_ID: 'usr.id',
  WAF_CONTEXT_PROCESSOR: 'waf.context.processor',

  HTTP_OUTGOING_URL: 'server.io.net.url'
}
