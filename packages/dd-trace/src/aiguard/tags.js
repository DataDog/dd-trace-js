'use strict'

module.exports = {
  RESOURCE: 'ai_guard',
  TARGET_TAG_KEY: 'ai_guard.target',
  TOOL_NAME_TAG_KEY: 'ai_guard.tool_name',
  ACTION_TAG_KEY: 'ai_guard.action',
  REASON_TAG_KEY: 'ai_guard.reason',
  BLOCKED_TAG_KEY: 'ai_guard.blocked',
  EVENT_TAG_KEY: 'ai_guard.event',
  META_STRUCT_KEY: 'ai_guard',

  HTTP_USERAGENT_TAG_KEY: 'ai_guard.http.useragent',
  HTTP_CLIENT_IP_TAG_KEY: 'ai_guard.http.client_ip',
  NETWORK_CLIENT_IP_TAG_KEY: 'ai_guard.network.client.ip',
  USR_ID_TAG_KEY: 'ai_guard.usr.id',
  USR_SESSION_ID_TAG_KEY: 'ai_guard.usr.session_id',

  TELEMETRY_REQUESTS: 'requests',
  TELEMETRY_TRUNCATED: 'truncated',
  TELEMETRY_ERROR: 'error',

  SOURCE_SDK: 'sdk',
  SOURCE_AUTO: 'auto',
  INTEGRATION_NONE: 'none',

  ERROR_TYPE_CLIENT: 'client_error',
  ERROR_TYPE_STATUS: 'bad_status',
  ERROR_TYPE_RESPONSE: 'bad_response',
}
