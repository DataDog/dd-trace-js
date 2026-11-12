import { get } from 'node:http'
import { NextResponse } from 'next/server'

function requestDownstream () {
  return new Promise((resolve, reject) => {
    const request = get(process.env.DOWNSTREAM_URL, response => {
      response.resume()
      response.on('end', resolve)
    })
    request.on('error', reject)
  })
}

export async function GET () {
  await requestDownstream()
  return NextResponse.json({}, { status: 200 })
}
