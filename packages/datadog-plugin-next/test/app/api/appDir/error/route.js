import { NextResponse } from 'next/server'

export async function GET (req) {
  try {
    throw new Error('error in app dir api route')
  } catch (error) {
    req.error = error
  }

  return NextResponse.json({}, { status: 500 })
}
