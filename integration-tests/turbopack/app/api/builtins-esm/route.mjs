import { lookup } from 'dns'
import { readFile } from 'fs'
import { request } from 'node:http'

export const runtime = 'nodejs'

export async function GET (incoming) {
  const [address, body] = await Promise.all([
    new Promise((resolve, reject) => {
      lookup('localhost', { family: 4 }, (error, address) => error ? reject(error) : resolve(address))
    }),
    new Promise((resolve, reject) => {
      const target = new URL(`http://${incoming.headers.get('host')}/builtin-target?source=esm`)
      // Avoid an implicit HTTP DNS lookup masking a missing span from the explicit lookup above.
      target.hostname = '127.0.0.1'
      const outgoing = request(target, result => {
        let body = ''
        result.setEncoding('utf8')
        result.on('data', chunk => { body += chunk })
        result.once('end', () => resolve(body))
        result.once('error', reject)
      })
      outgoing.once('error', reject)
      outgoing.end()
    }),
    new Promise((resolve, reject) => {
      readFile(process.argv[1], error => error ? reject(error) : resolve())
    }),
  ])
  return Response.json({ address, body })
}
