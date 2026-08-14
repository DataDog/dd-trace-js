'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const SupabaseFetchWithAuthPlugin = require('./supabase-supabase-js-fetchwithauth')
const SupabaseGoTrueClientGetUserPlugin = require('./supabase-auth-js-gotrueclient-getuser')
const SupabaseStorageBucketApiListBucketsPlugin = require('./supabase-storage-js-storagebucketapi-listbuckets')
const SupabaseRealtimeChannelSendPlugin = require('./supabase-realtime-js-realtimechannel-send')
const SupabaseFunctionsClientInvokePlugin = require('./supabase-functions-js-functionsclient-invoke')
const SupabasePostgrestBuilderThenPlugin = require('./supabase-postgrest-js-postgrestbuilder-then')

class SupabasePlugin extends CompositePlugin {
  static id = 'supabase'
  static plugins = {
    SupabaseFetchWithAuthPlugin,
    SupabaseGoTrueClientGetUserPlugin,
    SupabaseStorageBucketApiListBucketsPlugin,
    SupabaseRealtimeChannelSendPlugin,
    SupabaseFunctionsClientInvokePlugin,
    SupabasePostgrestBuilderThenPlugin,
  }
}

module.exports = SupabasePlugin
