const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBuildCommit } = require('./build-commit.cjs');

const noGit = () => { throw new Error('git は呼ばれないはず'); };

test('GITHUB_SHA が40桁なら先頭7桁', () => {
    const sha = 'deadbeef' + '0'.repeat(32);
    assert.equal(resolveBuildCommit({ GITHUB_SHA: sha }, noGit), 'deadbee');
});

test('GITHUB_SHA の大文字は小文字にする', () => {
    assert.equal(resolveBuildCommit({ GITHUB_SHA: 'ABCDEF1234567890' }, noGit), 'abcdef1');
});

test('GITHUB_SHA が不正なら無視して git へ', () => {
    let called = 0;
    const run = (cmd, args) => {
        called += 1;
        assert.equal(cmd, 'git');
        assert.deepEqual(args, ['rev-parse', '--short=7', 'HEAD']);
        return '1234567\n';
    };
    assert.equal(resolveBuildCommit({ GITHUB_SHA: 'not-a-sha' }, run), '1234567');
    assert.equal(called, 1);
});

test('GITHUB_SHA が7桁未満なら git へ', () => {
    assert.equal(resolveBuildCommit({ GITHUB_SHA: 'abc12' }, () => 'cafe123'), 'cafe123');
});

test('git が例外を投げたら unknown', () => {
    const run = () => { throw new Error('git なし'); };
    assert.equal(resolveBuildCommit({}, run), 'unknown');
});

test('git の出力が16進でなければ unknown', () => {
    assert.equal(resolveBuildCommit({}, () => 'fatal: not a git repository'), 'unknown');
});

test('git が8桁を返したら7桁に切る', () => {
    assert.equal(resolveBuildCommit({}, () => 'abcdef12\n'), 'abcdef1');
});
