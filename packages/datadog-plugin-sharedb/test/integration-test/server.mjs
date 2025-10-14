import ShareDB from 'sharedb'

const backend = new ShareDB({ presence: true })
const connection = backend.connect()
await connection.get('some-collection', 'some-id').fetch()
connection.close()
