// 収録用ビルドをループバックの空きポートで配信する。外部パッケージは使わない。
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
};

/** 指定ディレクトリを配信し、末尾スラッシュ付き URL と非同期の終了関数を返す。 */
export async function startStaticServer(rootDir) {
    const root = await realpath(rootDir);
    const isOutside = (file) => {
        const relative = path.relative(root, file);
        return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    };
    const server = createServer(async (req, res) => {
        let pathname;
        try {
            // URL の正規化で .. が消える前に検査する。クエリはファイル名に含めない。
            pathname = decodeURIComponent((req.url || '/').split('?')[0]);
        } catch {
            res.writeHead(400).end();
            return;
        }
        if (pathname.split(/[\\/]/).includes('..') || pathname.includes('\0')) {
            res.writeHead(403).end();
            return;
        }
        const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (isOutside(file)) {
            res.writeHead(403).end();
            return;
        }
        try {
            // シンボリックリンク経由でも配信ルート外へ出さない。
            const resolved = await realpath(file);
            if (isOutside(resolved)) {
                res.writeHead(403).end();
                return;
            }
            if (!(await stat(resolved)).isFile()) {
                res.writeHead(404).end();
                return;
            }
            const content = await readFile(resolved);
            res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream' });
            res.end(content);
        } catch (err) {
            res.writeHead(err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 404 : 500).end();
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    return {
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => new Promise((resolve, reject) => {
            server.close((err) => err ? reject(err) : resolve());
        }),
    };
}
