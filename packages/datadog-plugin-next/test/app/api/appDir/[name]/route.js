import { NextResponse } from 'next/server'

export async function GET (_request) {
  return NextResponse.json({}, { status: 200 })
}
