import { NextResponse } from 'next/server'

export default function middleware () {
  // the existence of this file will test that having middleware
  // doesn't break instrumentation in tests
  return NextResponse.next()
}
