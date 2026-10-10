// 子プロセスの環境変数の除外と、実行ファイル指定の解決を検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildChildEnv } from '../lib/cli.mjs';
import { resolveBin } from '../lib/inputs.mjs';

test('API 認証と親セッション由来の変数を除き、名前だけを返す', () => {
    const { env, removed } = buildChildEnv({
        PATH: 'p', USERPROFILE: 'u', ANTHROPIC_API_KEY: 'secret', anthropic_base_url: 'x',
        CLAUDE_EFFORT: 'high', CLAUDECODE: '1', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CONFIG_DIR: 'c',
    });
    assert.deepEqual(env, { PATH: 'p', USERPROFILE: 'u', CLAUDE_CONFIG_DIR: 'c' });
    assert.deepEqual(removed, [
        'ANTHROPIC_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_EFFORT', 'anthropic_base_url',
    ]);
    assert.ok(!JSON.stringify(removed).includes('secret'));
});

test('除く変数が無ければ環境をそのまま渡す', () => {
    assert.deepEqual(buildChildEnv({ PATH: 'p' }), { env: { PATH: 'p' }, removed: [] });
});

test('コマンド名だけの指定は PATH 検索に任せ、パス指定はルート基準で絶対化する', () => {
    const root = path.resolve('repo-root');
    assert.equal(resolveBin('claude', root), 'claude');
    assert.equal(resolveBin('./tools/claude.exe', root), path.join(root, 'tools', 'claude.exe'));
    if (process.platform === 'win32') {
        // バックスラッシュを区切りとして扱うのは Windows の path だけ。
        assert.equal(resolveBin('tools\\claude.exe', root), path.join(root, 'tools', 'claude.exe'));
    }
    const absolute = path.resolve('elsewhere', 'claude.exe');
    assert.equal(resolveBin(absolute, root), absolute);
});
