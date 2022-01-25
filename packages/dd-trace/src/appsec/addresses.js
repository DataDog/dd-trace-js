'use strict'

module.exports = {
  HTTP_INCOMING_URL: 'server.request.uri.raw',
  HTTP_INCOMING_HEADERS: 'server.request.headers.no_cookies',
  HTTP_INCOMING_METHOD: 'server.request.method',
  HTTP_INCOMING_REMOTE_IP: 'server.request.client_ip',
  HTTP_INCOMING_REMOTE_PORT: 'server.request.client_port',
  HTTP_INCOMING_RESPONSE_CODE: 'server.response.status',
  HTTP_INCOMING_RESPONSE_HEADERS: 'server.response.headers.no_cookies'
}
