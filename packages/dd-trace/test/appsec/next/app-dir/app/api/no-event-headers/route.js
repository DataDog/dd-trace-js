import { NextResponse } from 'next/server'

export async function GET () {
  const body = JSON.stringify({ ok: true })
  return new NextResponse(body, {
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    },
  })
}
