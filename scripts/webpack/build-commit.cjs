// Web 版の版表示に埋めるビルド元コミット。CI は GITHUB_SHA、ローカルは git、取れなければ unknown。
const { execFileSync } = require('child_process');

// 7桁に固定する。`git rev-parse --short` は衝突を避けて8桁以上を返すことがあるので切る。
// 'unknown' も7文字なので、ビルドごとのバイト数が変わらず check:bundle の実測が揺れない。
const SHORT = 7;

function resolveBuildCommit(env = process.env, run = execFileSync) {
    const fromEnv = (env.GITHUB_SHA || '').trim().toLowerCase();
    if (/^[0-9a-f]{7,40}$/.test(fromEnv)) return fromEnv.slice(0, SHORT);
    try {
        const out = String(run('git', ['rev-parse', `--short=${SHORT}`, 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })).trim().toLowerCase();
        if (/^[0-9a-f]{7,40}$/.test(out)) return out.slice(0, SHORT);
    } catch { /* git が無い・リポジトリ外 */ }
    return 'unknown';
}

module.exports = { resolveBuildCommit };
