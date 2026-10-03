import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs, usageText } from '../src/cli/args';

test('必須引数と既定値を解釈する', () => {
    assert.deepEqual(parseCliArgs(['--title', '試験', '--ris', 'input.ris']), {
        help: false, title: '試験', risPath: 'input.ris', share: [], dryRun: false, lang: 'ja',
    });
    for (const argv of [[], ['--title', '試験'], ['--ris', 'input.ris'], ['--title', '--ris', 'a']]) {
        assert.ok('error' in parseCliArgs(argv));
    }
});

test('共有先を分割して空白・空要素・重複を除く', () => {
    const args = parseCliArgs(['--title', '試験', '--ris', 'a', '--share', ' a@x, ,b@x,a@x ', '--share', 'b@x,c@x']);
    assert.ok(!('error' in args));
    assert.deepEqual(args.share, ['a@x', 'b@x', 'c@x']);
    assert.ok('error' in parseCliArgs(['--title', '試験', '--ris', 'a', '--share', 'invalid']));
});

test('未知のオプションと不正な言語を拒否する', () => {
    assert.ok('error' in parseCliArgs(['--unknown']));
    assert.ok('error' in parseCliArgs(['--lang', 'fr']));
    const args = parseCliArgs(['--title', '試験', '--ris', 'a', '--lang', 'en', '--dry-run']);
    assert.ok(!('error' in args));
    assert.equal(args.lang, 'en');
    assert.equal(args.dryRun, true);
});

test('ヘルプは必須引数なしで使える', () => {
    for (const flag of ['--help', '-h']) {
        const args = parseCliArgs([flag]);
        assert.ok(!('error' in args));
        assert.equal(args.help, true);
    }
    assert.match(usageText(), /使い方/);
});
