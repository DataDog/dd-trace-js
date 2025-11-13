import 'dd-trace/init.js'
import express from 'express'
import multer from 'multer'
import dc from 'dc-polyfill'

const multerReadCh = dc.channel('datadog:multer:read:finish')
let counter = 0
multerReadCh.subscribe(() => {
  counter += 1
})

const app = express()
const upload = multer({ storage: multer.memoryStorage() })

app.post('/upload', upload.single('file'), (req, res) => {
  res.setHeader('X-Counter', counter)
  res.send('File uploaded')
})

const server = app.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
