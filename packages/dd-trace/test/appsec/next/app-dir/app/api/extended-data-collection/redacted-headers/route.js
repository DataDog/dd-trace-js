import { NextResponse } from 'next/server'

export async function POST (request) {
  const body = await request.json()
  return NextResponse.json({ body }, {
    status: 200,
    headers: {
      authorization: 'header-value-1',
      'proxy-authorization': 'header-value-2',
      'www-authenticate': 'header-value-4',
      'proxy-authenticate': 'header-value-5',
      'authentication-info': 'header-value-6',
      'proxy-authentication-info': 'header-value-7',
      cookie: 'header-value-8',
      'set-cookie': 'header-value-9'
    }
  })
}
