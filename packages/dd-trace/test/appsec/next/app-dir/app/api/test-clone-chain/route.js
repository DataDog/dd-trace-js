import { NextResponse } from 'next/server'
export async function POST (request) {
  const body = await request.clone().clone().json()
  return NextResponse.json({
    now: Date.now(),
    cache: 'no-store',
    data: body,
  })
}
