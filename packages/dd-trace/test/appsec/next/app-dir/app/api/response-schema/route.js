import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET (request) {
  const params = new URL(request.url).searchParams
  const mode = params.get('mode')
  const body = mode === 'scalar' ? true : { value: 'café' }
  const init = { status: 201, headers: { 'content-type': 'application/json' } }
  if (mode === 'text') return new Response('text response', { status: 201 })
  if (mode === 'empty') return new Response(null, { status: 204 })
  return NextResponse.json(body, init)
}
