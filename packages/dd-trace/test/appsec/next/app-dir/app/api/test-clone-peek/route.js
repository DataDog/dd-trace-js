import { NextResponse } from 'next/server'
export async function POST (request) {
  await request.clone().json()
  const body = await request.json()
  return NextResponse.json({
    now: Date.now(),
    cache: 'no-store',
    data: body,
  })
}
