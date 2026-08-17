import 'dd-trace/init.js'
import tracer from 'dd-trace'

const { createClient } = await import('@supabase/supabase-js')

const SUPABASE_KEY = 'test-key'
const SUPABASE_URL = 'https://project.supabase.co'
const fails = process.env.DD_APM_SERVERLESS_SCENARIO === 'error'

function jsonResponse (body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function testFetch (input) {
  const url = String(input)

  if (url.includes('/auth/v1/user')) {
    return fails
      ? jsonResponse({ message: 'Invalid token' }, 401)
      : jsonResponse({ id: 'user-id', aud: 'authenticated', role: 'authenticated' })
  }

  if (url.includes('/storage/v1/')) {
    return fails ? jsonResponse({ message: 'Storage unavailable' }, 500) : jsonResponse([])
  }

  if (url.includes('/functions/v1/')) {
    return fails ? jsonResponse({ message: 'Function unavailable' }, 500) : jsonResponse({ ok: true })
  }

  if (url.includes('/rest/v1/')) {
    return fails
      ? jsonResponse({ message: 'Database unavailable', details: null, hint: null, code: 'PGRST500' }, 500)
      : jsonResponse([])
  }

  if (url.includes('/realtime/v1/api/broadcast')) {
    return fails ? jsonResponse({ message: 'Realtime unavailable' }, 500) : jsonResponse({ ok: true })
  }

  throw new Error(`Unexpected Supabase request: ${url}`)
}

async function supabaseFetch (input) {
  if (fails) throw new Error('Supabase request failed')
  return testFetch(input)
}

async function executeOperations () {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: { fetch: supabaseFetch },
    realtime: { timeout: 100 },
  })
  await supabase.storage.from('files').list()
  await supabase.auth.getUser('token')
  await supabase.storage.listBuckets()
  await supabase.channel('test-room').send({ type: 'broadcast', event: 'test', payload: { ok: !fails } })
  await supabase.functions.invoke('hello', { body: { name: 'test' } })
  await supabase.from('items').select('*')
}

await tracer.trace('serverless.test.invocation', executeOperations)
