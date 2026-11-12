import http from 'http'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

function get (url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      response.resume()
      resolve(response.statusCode)
    }).on('error', reject)
  })
}

export async function GET (request) {
  const { searchParams } = request.nextUrl
  const host = searchParams.get('host') ?? `127.0.0.1:${searchParams.get('port')}`

  try {
    return NextResponse.json({ status: await get(`http://${host}/`) })
  } catch (error) {
    if (searchParams.has('rethrow')) throw error

    return NextResponse.json({ error: error.name })
  }
}
