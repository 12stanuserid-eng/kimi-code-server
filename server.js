#!/usr/bin/env node
// Minimal test server - just returns HTTP 200
const http = require('http');
const PORT = parseInt(process.env.PORT) || 10000;

http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Kimi Code Server OK\n');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on ${PORT}`);
});
