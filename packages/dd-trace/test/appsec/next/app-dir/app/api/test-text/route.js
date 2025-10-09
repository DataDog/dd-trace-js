import { NextResponse } from 'next/server'
export async function POST (request) {
  const body = await request.text()
  return NextResponse.json({
    now: Date.now(),
    cache: 'no-store',
    data: body
  }, {
    status: 200,
    headers: {
      'custom-response-header-1': 'custom-response-header-value-1',
      'custom-response-header-2': 'custom-response-header-value-2',
      'Content-Type': 'application/json'
    }
  })
}
