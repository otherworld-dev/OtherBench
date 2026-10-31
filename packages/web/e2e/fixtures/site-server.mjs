// A one-page site on 127.0.0.1 for browser.spec.ts: the model's browser
// reaches it only because the e2e server sets OTHERBENCH_BROWSER_ALLOW_LOOPBACK_PORTS
// to this port. No test browses the internet.
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4797);
const page = [
  '<!doctype html>',
  '<title>Fixture site</title>',
  '<h1>Fixture heading</h1>',
  '<p>A page for the browser end-to-end test.</p>',
].join('\n');

/** A page that stays stuck until a person clicks it: anywhere will do, so the test needn't know where the button lands in the picture. */
const check = [
  '<!doctype html>',
  '<title>Check</title>',
  '<h1>Are you human?</h1>',
  "<script>addEventListener('click', () => { document.querySelector('h1').textContent = 'Cleared by hand'; });</script>",
].join('\n');

createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(req.url === '/check' ? check : page);
}).listen(port, '127.0.0.1');
