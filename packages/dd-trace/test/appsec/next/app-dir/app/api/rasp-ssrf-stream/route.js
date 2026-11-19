import http from 'http'

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
  const host = request.nextUrl.searchParams.get('host')

  // The outgoing request runs before the first chunk, once Next.js is already streaming the response.
  const stream = new ReadableStream({
    async start (controller) {
      controller.enqueue(new TextEncoder().encode(String(await get(`http://${host}/`))))
      controller.close()
    },
  })

  return new Response(stream, { headers: { 'content-type': 'text/plain' } })
}
