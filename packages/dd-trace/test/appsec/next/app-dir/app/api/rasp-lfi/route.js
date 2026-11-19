import fs from 'fs'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET (request) {
  const { searchParams } = request.nextUrl

  try {
    return NextResponse.json({ length: fs.readFileSync(searchParams.get('file')).length })
  } catch (error) {
    if (searchParams.has('rethrow')) throw error

    return NextResponse.json({ error: error.name })
  }
}
