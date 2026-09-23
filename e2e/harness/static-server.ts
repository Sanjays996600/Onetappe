import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
};

/**
 * Serves an app's web export (a single-page app): files as they are, every other path gets
 * index.html so the app's router decides. Test use only.
 */
export function serveStatic(dir: string, port: number): Promise<Server> {
  const root = path.resolve(dir);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory())
      file = path.join(root, 'index.html');
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    }),
  );
}
