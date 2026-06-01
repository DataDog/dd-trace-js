import { NextResponse } from 'next/server'

export async function GET (req) {
  req.error = new Error('error in app dir api route')

  return NextResponse.json({}, { status: 500 })
}
