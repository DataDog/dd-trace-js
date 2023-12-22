const { port } = require('./common')

async function sendData (url, body) {
  const res = await fetch(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body
    }
  )
  return res
}

const url = new URL('/endpoint', `http://localhost:${port}`)
const body = require('./payload.json')
sendData(url, body)
  .then(res => res.text().then(text => console.log(text)))
  .catch(err => console.log(err))
