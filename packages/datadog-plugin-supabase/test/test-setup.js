'use strict'

const SUPABASE_KEY = 'test-key'
const SUPABASE_URL = 'https://project.supabase.co'

function jsonResponse (body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function createFetch ({ abort = false, fail = false, reject = false } = {}) {
  return async function (input) {
    if (abort) {
      const error = new Error('Supabase request timed out')
      error.name = 'AbortError'
      throw error
    }
    if (reject) throw new Error('Supabase request failed')

    const url = input?.url || input?.href || String(input)

    if (url.includes('/auth/v1/user')) {
      return fail
        ? jsonResponse({ message: 'Invalid token' }, 401)
        : jsonResponse({ id: 'user-id', aud: 'authenticated', role: 'authenticated' })
    }

    if (url.includes('/storage/v1/')) {
      return fail ? jsonResponse({ message: 'Storage unavailable' }, 500) : jsonResponse([])
    }

    if (url.includes('/functions/v1/')) {
      return fail ? jsonResponse({ message: 'Function unavailable' }, 500) : jsonResponse({ ok: true })
    }

    if (url.includes('/rest/v1/')) {
      return fail
        ? jsonResponse({ message: 'Database unavailable', details: null, hint: null, code: 'PGRST500' }, 500)
        : jsonResponse([])
    }

    if (url.includes('/realtime/v1/api/broadcast')) {
      return fail ? jsonResponse({ message: 'Realtime unavailable' }, 500) : jsonResponse({ ok: true })
    }

    throw new Error(`Unexpected Supabase request: ${url}`)
  }
}

class SupabaseTestSetup {
  /**
   * @param {{ createClient: Function }} module Supabase module under test.
   * @returns {Promise<void>}
   */
  async setup (module) {
    this.createClient = module.createClient
  }

  /** @returns {Promise<void>} */
  async teardown () {
    this.createClient = undefined
  }

  /**
   * @param {{ abort?: boolean, fail?: boolean, reject?: boolean, throwOnError?: boolean }} [options] Client behavior.
   * @returns {import('@supabase/supabase-js').SupabaseClient}
   */
  createSupabaseClient (options) {
    return this.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
        throwOnError: options?.throwOnError,
      },
      global: { fetch: createFetch(options) },
      realtime: { timeout: 100 },
    })
  }

  /** @returns {Promise<object>} */
  storageFileList () {
    return this.createSupabaseClient().storage.from('files').list()
  }

  /** @returns {Promise<object>} */
  storageFileListError () {
    return this.createSupabaseClient({ fail: true }).storage.from('files').list()
  }

  /** @returns {Promise<object>} */
  storageFileListTransportError () {
    return this.createSupabaseClient({ reject: true }).storage.from('files').list()
  }

  /**
   * @param {string} path Storage object path.
   * @returns {Promise<object>}
   */
  storageFileInfo (path) {
    return this.createSupabaseClient().storage.from('files').info(path)
  }

  /** @returns {Promise<object>} */
  goTrueClientGetUser () {
    return this.createSupabaseClient().auth.getUser('token')
  }

  /** @returns {Promise<object>} */
  goTrueClientGetUserError () {
    return this.createSupabaseClient({ fail: true }).auth.getUser('token')
  }

  /** @returns {Promise<object>} */
  goTrueClientGetUserTransportError () {
    return this.createSupabaseClient({ reject: true }).auth.getUser('token')
  }

  /** @returns {Promise<object>} */
  goTrueClientGetUserRejected () {
    return this.createSupabaseClient({ reject: true, throwOnError: true }).auth.getUser('token')
  }

  /** @returns {Promise<object>} */
  storageBucketApiListBuckets () {
    return this.createSupabaseClient().storage.listBuckets()
  }

  /** @returns {Promise<object>} */
  storageBucketApiListBucketsError () {
    return this.createSupabaseClient({ fail: true }).storage.listBuckets()
  }

  /** @returns {Promise<object>} */
  storageBucketApiListBucketsTransportError () {
    return this.createSupabaseClient({ reject: true }).storage.listBuckets()
  }

  /** @returns {Promise<object>} */
  storageBucketApiListBucketsRejected () {
    return this.createSupabaseClient({ reject: true }).storage.throwOnError().listBuckets()
  }

  /** @returns {Promise<string>} */
  realtimeChannelSend () {
    const channel = this.createSupabaseClient().channel('test-room')
    return channel.send({ type: 'broadcast', event: 'test', payload: { ok: true } })
  }

  /** @returns {Promise<string>} */
  realtimeChannelSendError () {
    const channel = this.createSupabaseClient({ fail: true }).channel('test-room')
    return channel.send({ type: 'broadcast', event: 'test', payload: { ok: false } })
  }

  /** @returns {Promise<string>} */
  realtimeChannelSendTransportError () {
    const channel = this.createSupabaseClient({ reject: true }).channel('test-room')
    return channel.send({ type: 'broadcast', event: 'test', payload: { ok: false } })
  }

  /** @returns {Promise<string>} */
  realtimeChannelSendTimeout () {
    const channel = this.createSupabaseClient({ abort: true }).channel('test-room')
    return channel.send({ type: 'broadcast', event: 'test', payload: { ok: false } })
  }

  /** @returns {Promise<object>} */
  functionsClientInvoke () {
    return this.createSupabaseClient().functions.invoke('hello', { body: { name: 'test' } })
  }

  /** @returns {Promise<object>} */
  functionsClientInvokeError () {
    return this.createSupabaseClient({ fail: true }).functions.invoke('hello', { body: { name: 'test' } })
  }

  /** @returns {Promise<object>} */
  functionsClientInvokeTransportError () {
    return this.createSupabaseClient({ reject: true }).functions.invoke('hello', { body: { name: 'test' } })
  }

  /** @returns {Promise<object>} */
  functionsClientInvokeDelete () {
    return this.createSupabaseClient().functions.invoke('hello', { method: 'DELETE' })
  }

  /** @returns {Promise<object>} */
  postgrestBuilderThen () {
    return this.createSupabaseClient().from('items').select('*')
  }

  /**
   * @param {(result: object) => unknown} onFulfilled Query fulfillment callback.
   * @returns {Promise<unknown>}
   */
  postgrestBuilderThenWithCallback (onFulfilled) {
    return this.createSupabaseClient().from('items').select('*').then(onFulfilled)
  }

  /** @returns {Promise<object>} */
  postgrestBuilderThenHead () {
    return this.createSupabaseClient().from('items').select('*', { head: true })
  }

  /** @returns {Promise<object>} */
  postgrestBuilderThenInsert () {
    return this.createSupabaseClient().from('items').insert({ name: 'created' })
  }

  /** @returns {Promise<object>} */
  postgrestBuilderThenUpdate () {
    return this.createSupabaseClient().from('items').update({ name: 'updated' }).eq('id', 1)
  }

  /** @returns {Promise<object>} */
  postgrestBuilderThenDelete () {
    return this.createSupabaseClient().from('items').delete().eq('id', 1)
  }

  /** @returns {Promise<object>} */
  postgrestBuilderThenRpc () {
    return this.createSupabaseClient().rpc('refresh_items')
  }

  /** @returns {Promise<object>} */
  postgrestBuilderThenError () {
    return this.createSupabaseClient({ fail: true }).from('items').select('*').retry(false)
  }

  /** @returns {Promise<object>} */
  postgrestBuilderThenTransportError () {
    return this.createSupabaseClient({ reject: true }).from('items').select('*').retry(false)
  }

  /** @returns {Promise<object>} */
  postgrestBuilderThenRejected () {
    return this.createSupabaseClient({ reject: true }).from('items').select('*').retry(false).throwOnError()
  }
}

module.exports = SupabaseTestSetup
