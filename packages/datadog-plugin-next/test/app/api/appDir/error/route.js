import { NextResponse } from 'next/server'

export async function GET (req) {
  let status = 200
  try {
    throw new Error('error in app dir api route')
  } catch (error) {
    req.error = error
    status = 500
  }

  return NextResponse.json({}, { status })
}
