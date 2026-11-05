import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

export async function serve(root, port = 0) {
  root = path.resolve(root);
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push(url.pathname);
    try {
      let name = decodeURIComponent(url.pathname);
      if (name.startsWith('/neon-fist/')) name = name.slice('/neon-fist'.length);
      if (name.endsWith('/')) name += 'index.html';
      const file = path.resolve(root, `.${name}`);
      if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) throw new Error('Not found');
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('Not found');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, requests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
