'use strict'

const assert = require('node:assert')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { createServer: createNetServer } = require('node:net')
const { after, test } = require('node:test')
const { Client } = require('..')

function readBody (body) {
  return new Promise((resolve, reject) => {
    let data = ''
    body.setEncoding('latin1')
    body.on('data', chunk => { data += chunk })
    body.on('end', () => resolve(data))
    body.on('error', reject)
  })
}

test('should not reuse an idle socket with buffered unsolicited response bytes', async () => {
  let evilServerSocket

  const server = createServer((req, res) => {
    if (!evilServerSocket) {
      evilServerSocket = req.socket
    }

    res.end(req.url)
  })
  after(() => server.close())

  await new Promise(resolve => server.listen(0, resolve))

  const client = new Client(`http://localhost:${server.address().port}`, {
    keepAliveTimeout: 300e3
  })
  after(() => client.close())

  const response1 = await client.request({ path: '/request1', method: 'GET' })
  assert.strictEqual(await readBody(response1.body), '/request1')

  const disconnected = once(client, 'disconnect')

  evilServerSocket.write(
    'HTTP/1.1 200 OK\r\n' +
    'Poison-Free-Socket: true\r\n' +
    'Connection: keep-alive\r\n' +
    'Keep-Alive: timeout=300\r\n' +
    'Content-Length: 0\r\n' +
    '\r\n'
  )

  await disconnected

  const response2 = await client.request({ path: '/request2', method: 'GET' })
  assert.strictEqual(response2.headers['poison-free-socket'], undefined)
  assert.strictEqual(await readBody(response2.body), '/request2')
})

test('should not attribute an unsolicited response to a queued request', async () => {
  // The malicious server answers request1 and appends an unsolicited second
  // response in the same write. request2 is queued while request1 is still in
  // flight, so the running index already points at request2 by the time the
  // unsolicited response is parsed - without the fix that response is handed
  // to request2, which was never even sent.
  let responses = 0

  const server = createNetServer((socket) => {
    socket.on('data', () => {
      if (responses++ === 0) {
        socket.write(
          'HTTP/1.1 200 OK\r\n' +
          'Connection: keep-alive\r\n' +
          'Keep-Alive: timeout=300\r\n' +
          'Content-Length: 9\r\n' +
          '\r\n' +
          '/request1' +
          'HTTP/1.1 200 OK\r\n' +
          'Poison-Free-Socket: true\r\n' +
          'Connection: keep-alive\r\n' +
          'Keep-Alive: timeout=300\r\n' +
          'Content-Length: 0\r\n' +
          '\r\n'
        )
      } else {
        socket.write(
          'HTTP/1.1 200 OK\r\n' +
          'Connection: keep-alive\r\n' +
          'Keep-Alive: timeout=300\r\n' +
          'Content-Length: 9\r\n' +
          '\r\n' +
          '/request2'
        )
      }
    })
  })
  after(() => server.close())

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const client = new Client(`http://127.0.0.1:${server.address().port}`, {
    keepAliveTimeout: 300e3
  })
  after(() => client.close())

  const pending1 = client.request({ path: '/request1', method: 'GET' })
  const pending2 = client.request({ path: '/request2', method: 'GET' })

  const response1 = await pending1
  assert.strictEqual(await readBody(response1.body), '/request1')

  const response2 = await pending2
  assert.strictEqual(response2.headers['poison-free-socket'], undefined)
  assert.strictEqual(await readBody(response2.body), '/request2')
})
