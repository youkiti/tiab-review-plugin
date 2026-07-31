// package.json のバージョン文字列を取得する（タイトルカード/エンドカードの ?version= 用）
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../scripts/config.mjs';

export function readPkgVersion() {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return pkg.version;
}
