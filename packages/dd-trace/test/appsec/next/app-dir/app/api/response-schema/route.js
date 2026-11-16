import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET (request) {
  const params = new URL(request.url).searchParams
  const requestedMode = params.get('mode') || 'json'
  const native = requestedMode.startsWith('native-')
  const mode = native ? requestedMode.slice(7) : requestedMode
  const JsonResponse = native ? Response : NextResponse
  const body = mode === 'scalar' ? true : { value: 'café' }
  const init = { status: 201, headers: { 'content-type': 'application/json' } }
  if (mode === 'discarded-json') {
    JsonResponse.json({ internalOnly: true }, init)
    return new Response('text response', { status: 201 })
  }
  if (mode === 'discarded-first-json') JsonResponse.json({ discarded: true }, init)
  if (mode === 'selected-json') {
    const response = JsonResponse.json(body, init)
    JsonResponse.json({ discarded: true }, init)
    return response
  }
  if (mode === 'streamed-json') return new Response(new Blob([JSON.stringify(body)]).stream(), init)
  if (mode === 'text') return new Response('text response', { status: 201 })
  if (mode === 'empty') return new Response(null, { status: 204 })
  return JsonResponse.json(body, init)
}
