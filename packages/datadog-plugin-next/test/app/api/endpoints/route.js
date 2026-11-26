import { NextResponse } from 'next/server'

// Keeps the GET handler out of the build-time prerender, so requests reach the route module.
export const dynamic = 'force-dynamic'

export async function GET () {
  return NextResponse.json({ method: 'GET' })
}

export async function POST () {
  return NextResponse.json({ method: 'POST' })
}
