// A one-page site on 127.0.0.1 for browser.spec.ts: the model's browser
// reaches it only because the e2e server sets GRUNT_BROWSER_ALLOW_LOOPBACK_PORTS
// to this port. No test browses the internet.
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4797);
const page = [
  '<!doctype html>',
  '<title>Fixture site</title>',
  '<h1>Fixture heading</h1>',
  '<p>A page for the browser end-to-end test.</p>',
].join('\n');

createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
}).listen(port, '127.0.0.1');
