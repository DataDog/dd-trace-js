import 'dd-trace/init.js'
import tracer from 'dd-trace'

const [
  { GoTrueClient },
  { FunctionsClient },
  { PostgrestClient },
  { RealtimeClient },
  { StorageClient },
  { createClient },
] = await Promise.all([
  import('@supabase/auth-js'),
  import('@supabase/functions-js'),
  import('@supabase/postgrest-js'),
  import('@supabase/realtime-js'),
  import('@supabase/storage-js'),
  import('@supabase/supabase-js'),
])

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

async function fetchWithAuthTest (input) {
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
    global: { fetch: fetchWithAuthTest },
  })
  await supabase.storage.from('files').list()

  const auth = new GoTrueClient({
    url: `${SUPABASE_URL}/auth/v1`,
    headers: { apikey: SUPABASE_KEY },
    fetch: testFetch,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: false,
  })
  await auth.getUser('token')

  const storage = new StorageClient(`${SUPABASE_URL}/storage/v1`, { apikey: SUPABASE_KEY }, testFetch)
  await storage.listBuckets()

  const realtime = new RealtimeClient(`wss://project.supabase.co/realtime/v1`, {
    params: { apikey: SUPABASE_KEY },
    fetch: testFetch,
    timeout: 100,
  })
  await realtime.channel('test-room').send({ type: 'broadcast', event: 'test', payload: { ok: !fails } })

  const functions = new FunctionsClient(`${SUPABASE_URL}/functions/v1`, { customFetch: testFetch })
  await functions.invoke('hello', { body: { name: 'test' } })

  const postgrest = new PostgrestClient(`${SUPABASE_URL}/rest/v1`, { fetch: testFetch })
  await postgrest.from('items').select('*')
}

await tracer.trace('serverless.test.invocation', executeOperations)
