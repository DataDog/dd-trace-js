'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const SupabaseGoTrueClientGetUserPlugin = require('./supabase-auth-js-gotrueclient-getuser')
const SupabaseStorageHandleRequestPlugin = require('./supabase-storage-js-handle-request')
const SupabaseRealtimeChannelSendPlugin = require('./supabase-realtime-js-realtimechannel-send')
const SupabaseFunctionsClientInvokePlugin = require('./supabase-functions-js-functionsclient-invoke')
const SupabasePostgrestBuilderThenPlugin = require('./supabase-postgrest-js-postgrestbuilder-then')

class SupabasePlugin extends CompositePlugin {
  static id = 'supabase'
  static plugins = {
    SupabaseGoTrueClientGetUserPlugin,
    SupabaseStorageHandleRequestPlugin,
    SupabaseRealtimeChannelSendPlugin,
    SupabaseFunctionsClientInvokePlugin,
    SupabasePostgrestBuilderThenPlugin,
  }
}

module.exports = SupabasePlugin
