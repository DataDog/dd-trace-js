import { get } from 'node:http'

export const dynamic = 'force-dynamic'

function getDownstream () {
  return new Promise((resolve, reject) => {
    const request = get(`http://127.0.0.1:${process.env.DOWNSTREAM_PORT}/app-page-downstream`, response => {
      response.resume()
      response.on('end', resolve)
    })
    request.on('error', reject)
  })
}

export default async function Page () {
  await getDownstream()

  return <h1>App Page Trace Shape</h1>
}
