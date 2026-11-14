import { NextResponse } from 'next/server'
export async function POST () {
  const internalRequest = new Request('http://127.0.0.1/', {
    method: 'POST',
    body: JSON.stringify({ key: 'blockattack' }),
  })
  const body = await internalRequest.json()
  return NextResponse.json({
    now: Date.now(),
    cache: 'no-store',
    data: body,
  })
}
