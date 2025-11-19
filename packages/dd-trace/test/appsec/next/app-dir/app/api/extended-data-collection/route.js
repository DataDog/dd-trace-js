import { NextResponse } from 'next/server'

export async function POST (request) {
  const body = await request.json()
  return NextResponse.json({ body }, {
    status: 200,
    headers: {
      'custom-response-header-1': 'custom-response-header-value-1',
      'custom-response-header-2': 'custom-response-header-value-2',
      'custom-response-header-3': 'custom-response-header-value-3',
      'custom-response-header-4': 'custom-response-header-value-4',
      'custom-response-header-5': 'custom-response-header-value-5',
      'custom-response-header-6': 'custom-response-header-value-6',
      'custom-response-header-7': 'custom-response-header-value-7',
      'custom-response-header-8': 'custom-response-header-value-8',
      'custom-response-header-9': 'custom-response-header-value-9',
      'custom-response-header-10': 'custom-response-header-value-10'
    }
  })
}
