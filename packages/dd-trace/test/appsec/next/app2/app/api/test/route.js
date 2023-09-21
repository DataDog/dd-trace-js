import { NextResponse } from 'next/server'
export async function POST (request) {
  const body = await request.json()
  return NextResponse.json({
    now: Date.now(),
    cache: 'no-store',
    data: body
  })
}
export async function GET (request) {
  return NextResponse.json({
    now: Date.now(),
    cache: 'no-store',
    data: request.nextUrl.searchParams
  })
}

export default async function handler (request) {
  const resData = {
    now: Date.now(),
    cache: 'no-store'
  }
  if (request.method === 'POST') {
    resData.data = await request.json()
  } else {
    resData.data = request.nextUrl.searchParams
  }
  return NextResponse.json(resData)
}
