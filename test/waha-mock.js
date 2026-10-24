// Extracted from the M4 workflow mock; extended with scripted media responses.
const http = require('node:http');
async function createWahaMock() {
  const calls = [], replies = [];
  const server = http.createServer((req, res) => {
    if (req.headers['x-api-key'] !== 'test-waha-key') { res.writeHead(401); return res.end(); }
    if (req.method !== 'POST' || !['/api/sendText','/api/sendImage','/api/sendFile','/api/sendVoice'].includes(req.url)) {
      res.writeHead(404); return res.end();
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { res.writeHead(400); return res.end(); }
      calls.push({ path: req.url, body, at: Date.now() });
      const reply = replies.shift() || 201;
      if (reply === 'timeout') return;
      if (reply === 'network') return req.socket.destroy();
      res.writeHead(reply, { 'content-type': 'application/json' });
      // Echoed sensitive strings must never enter scheduler logs or lastError.
      res.end(JSON.stringify(reply < 300 ? { id: 'mock-message-id-123' } : { error: 'SECRET_ECHO_BASE64_AUTHORIZATION' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, replies, url: `http://127.0.0.1:${server.address().port}`,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { createWahaMock };
