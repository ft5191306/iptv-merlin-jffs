#!/usr/bin/env node
// lan-files.js — tiny HTTP file server used to move files between the PC and
// the router. Asuswrt's SSH has no base64, no SFTP subsystem, and heredocs plus
// long commands get truncated, so the reliable path is:
//
//   router -> PC :  curl -s -o /jffs/scripts/x.sh http://<pc>:8899/scripts/x.sh
//   PC -> router :  curl -X PUT --data-binary @file http://<pc>:8899/out/file
//
// Serves (GET) and accepts (PUT/POST) files relative to the current directory.
// Rooted at the working directory; path traversal is rejected.
//
// Usage: node lan-files.js [port]

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 8899);
const ROOT = process.cwd();

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const target = path.resolve(ROOT, rel);
  if (!target.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('forbidden');
  }

  if (req.method === 'GET') {
    fs.stat(target, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, {
        'Content-Length': st.size,
        'Content-Type': 'application/octet-stream',
      });
      fs.createReadStream(target).pipe(res);
    });
  } else if (req.method === 'PUT' || req.method === 'POST') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const ws = fs.createWriteStream(target);
    let n = 0;
    req.on('data', (d) => { n += d.length; });
    req.pipe(ws);
    ws.on('close', () => {
      console.log(`PUT ${rel} ${n} bytes`);
      res.writeHead(200);
      res.end('ok ' + n);
    });
    ws.on('error', (e) => {
      res.writeHead(500);
      res.end(String(e));
    });
  } else {
    res.writeHead(405);
    res.end('no');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`serving ${ROOT} on http://0.0.0.0:${PORT}`);
});
