import { NextResponse } from 'next/server'
export async function POST (request) {
  const body = await request.formData()

  if (!body.entries) {
    return NextResponse.json({
      message: 'Instrumentation modified form data'
    }, {
      status: 500
    })
  }

  return NextResponse.json({
    now: Date.now(),
    cache: 'no-store',
    data: body
  })
}
