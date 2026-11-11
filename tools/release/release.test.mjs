// 実際の git・gh・ストア・PowerShell は呼ばず、run を偽物に差し替えて、続きの位置の判定と各段の分岐を検査する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { main, replaceChangelogHeading, nextVersion, summarizeChecks, parseArgs, StopError, TAG_FROM_AFTER_VERSION } from './release.mjs';

const pass = (names = ['quality', 'build-extension', 'build-web', 'bundle-budget']) => JSON.stringify(names.map((name) => ({ name, bucket: 'pass', link: `https://example.test/${name}` })));
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const ng = (stdout = '') => ({ status: 1, stdout, stderr: '' });
const storeStatus = (published, submitted) => JSON.stringify({
  publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: published }] },
  ...(submitted ? { submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: submitted }] } } : {}),
});
const changelog = (heading = '## 未リリース') => `﻿# 変更履歴\r\n\r\n${heading}\r\n\r\n- 追加した\r\n\r\n## v0.57.2（2026-11-09）\r\n\r\n- 前の版\r\n`;

// override(key, args, state) が undefined 以外を返せばそれを使う。key は "cmd arg arg ..."。
function harness({ override = () => undefined, argv = ['--bump', 'patch'], files = {}, checks } = {}) {
  const calls = [];
  const outputs = [];
  const sleeps = [];
  const written = {};
  let clock = new Date(2026, 10, 12, 10, 0, 0).getTime();
  const state = { head: 'abc', checkCalls: 0 };
  const fileMap = { 'package.json': '{"version":"0.57.2"}', '.env': 'WEBAUTH_CLIENT_ID=client-id\n', 'CHANGELOG.md': changelog(), ...files };
  const run = (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    calls.push(key);
    const custom = override(key, args, state);
    if (custom !== undefined) return custom;
    if (key === 'git pull --ff-only origin main') { state.head = 'merge1'; return ok(); }
    if (key === 'git rev-parse HEAD') return ok(`${state.head}\n`);
    if (key === 'git rev-parse origin/main') return ok('abc\n');
    if (key === 'git branch --show-current') return ok('main\n');
    if (key.startsWith('git status')) return ok('');
    if (key === 'git show origin/main:package.json') return ok('{"version":"0.57.2"}');
    if (key === 'node tools/release/storeApi.mjs status --json') return ok(storeStatus('0.57.2'));
    if (key.startsWith('git ls-remote')) return ok('');
    if (key === 'gh pr list --state open --base main --json number,headRefName') return ok('[]');
    if (key.startsWith('gh pr create')) return ok('https://github.com/youkiti/tiab-review-plugin/pull/301\n');
    if (key.startsWith('gh pr checks')) { state.checkCalls++; return ok(checks ? checks(state.checkCalls) : pass()); }
    if (key.startsWith('gh pr view')) return ok('{"state":"MERGED","mergeCommit":{"oid":"merge1"}}');
    return ok();
  };
  const run2 = async (cmd, args, options) => run(cmd, args, options);
  const deps = {
    argv, run: run2,
    readFile: (path) => {
      if (!(path in fileMap)) throw new Error(`ENOENT ${path}`);
      return fileMap[path];
    },
    writeFile: (path, text) => { written[path] = text; if (path.endsWith('CHANGELOG.md')) fileMap['CHANGELOG.md'] = text; },
    removeFile: () => {},
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    now: () => clock,
    output: (message) => outputs.push(message),
    tmp: '/tmp-test',
  };
  return { deps, calls, outputs, sleeps, written, fileMap, state };
}

// 段6のタグの push（git push origin refs/tags/vX）は版上げのブランチの push と区別する。
const isBranchPush = (call) => call.startsWith('git push') && !call.startsWith('git push origin refs/tags/v');
const index = (calls, prefix) => calls.findIndex((call) => call.startsWith(prefix));
const writeCommands = ['git switch', 'git commit', 'git push', 'gh pr create', 'gh pr merge', 'npm run build:release', 'node tools/release/storeApi.mjs submit'];

test('新規リリースは決まった順序で進み、main へ直接 push しない', async () => {
  const h = harness();
  assert.equal(await main(h.deps), 0);
  const order = [
    'gh auth status', 'git fetch origin main --tags', 'node tools/release/storeApi.mjs status --require-submittable',
    'git ls-remote --heads origin chore/release-v0.57.3', 'git switch -c chore/release-v0.57.3 origin/main', 'git add CHANGELOG.md',
    'git commit -m docs: CHANGELOG に v0.57.3 を書く',
    'powershell -ExecutionPolicy Bypass -File scripts/bump-version.ps1 -SetVersion 0.57.3',
    'git push -u origin chore/release-v0.57.3', 'gh pr create --base main --head chore/release-v0.57.3',
    'gh pr checks 301', 'gh pr merge 301 --merge --delete-branch', 'git pull --ff-only origin main',
    'npm run build:release', 'node tools/release/storeApi.mjs submit',
  ];
  let last = -1;
  for (const prefix of order) {
    const at = h.calls.findIndex((call, i) => i > last && call.startsWith(prefix));
    assert.ok(at > last, `${prefix} が順序どおりに呼ばれていません\n${h.calls.join('\n')}`);
    last = at;
  }
  assert.ok(!h.calls.some((call) => call.includes('HEAD:main')));
  assert.ok(!h.calls.some((call) => /^git push/.test(call) && !call.startsWith('git push -u origin chore/release-v') && !call.startsWith('git push origin refs/tags/v')));
  assert.match(h.outputs.at(-1), /v0\.57\.3 をストアへ審査提出しました/);
  const body = Object.entries(h.written).find(([path]) => path.endsWith('release-pr-body-0.57.3.md'))[1];
  assert.match(body, /## v0\.57\.3（2026-11-12）/);
  assert.match(body, /必須チェックが通ると自動でマージします/);
});

test('major は中央の数字を上げる', async () => {
  const h = harness({ argv: ['--bump', 'major'] });
  assert.equal(await main(h.deps), 0);
  assert.ok(h.calls.includes('powershell -ExecutionPolicy Bypass -File scripts/bump-version.ps1 -SetVersion 0.58.0'));
});

test('CHANGELOG の見出し置き換え: 両方の表記が版の節になり、改行と BOM は保たれる', () => {
  for (const heading of ['## 未リリース', '## 未リリース / Unreleased']) {
    const out = replaceChangelogHeading(changelog(heading), '0.57.3', '2026-11-12');
    assert.equal(out, changelog('## v0.57.3（2026-11-12）'));
    assert.ok(out.startsWith('﻿'));
  }
  assert.throws(() => replaceChangelogHeading('## 未リリース\n\n## 未リリース / Unreleased\n', '0.57.3', '2026-11-12'), StopError);
  assert.throws(() => replaceChangelogHeading('## v0.57.2（2026-11-09）\n', '0.57.3', '2026-11-12'), StopError);
});

test('CHANGELOG の「未リリース」が無い・2つあるときは、何も変えずに止まる', async () => {
  for (const text of ['# 履歴\n\n## v0.57.2（2026-11-09）\n', '## 未リリース\n\n## 未リリース / Unreleased\n']) {
    const h = harness({ files: { 'CHANGELOG.md': text } });
    assert.equal(await main(h.deps), 1);
    assert.ok(!h.calls.some((call) => writeCommands.some((prefix) => call.startsWith(prefix))));
    assert.deepEqual(h.written, {});
  }
});

const prerequisiteFailures = {
  'gh 未ログイン': { override: (key) => key === 'gh auth status' ? ng() : undefined },
  'main 以外': { override: (key) => key === 'git branch --show-current' ? ok('feature/x\n') : undefined },
  '作業ツリーが汚れている': { override: (key) => key.startsWith('git status') ? ok(' M a.ts\n') : undefined },
  'HEAD と origin/main の不一致': { override: (key) => key === 'git rev-parse origin/main' ? ok('zzz\n') : undefined },
  'WEBAUTH_CLIENT_ID が空': { files: { '.env': 'WEBAUTH_CLIENT_ID=\nOTHER=1\n' } },
  'ストア提出不可': { override: (key) => key.endsWith('--require-submittable') ? ng() : undefined },
  '同名のブランチが origin にある': { override: (key) => key.startsWith('git ls-remote --heads') ? ok('deadbeef\trefs/heads/chore/release-v0.57.3\n') : undefined },
  '同名のタグが origin にある': { override: (key) => key.startsWith('git ls-remote --tags') ? ok('deadbeef\trefs/tags/v0.57.3\n') : undefined },
};
for (const [name, setup] of Object.entries(prerequisiteFailures)) {
  test(`前提確認の失敗（${name}）は git switch -c より前で止まる`, async () => {
    const h = harness(setup);
    assert.equal(await main(h.deps), 1);
    assert.ok(!h.calls.some((call) => writeCommands.some((prefix) => call.startsWith(prefix))), h.calls.join('\n'));
    assert.match(h.outputs.at(-1), /\u001b\[31m/);
  });
}

test('チェック待ち: 4つが pass になるまで sleep を挟んで読み直す', async () => {
  const h = harness({ checks: (n) => n < 3 ? JSON.stringify([{ name: 'quality', bucket: 'pass' }, { name: 'build-extension', bucket: 'pending' }]) : pass() });
  assert.equal(await main(h.deps), 0);
  assert.equal(h.state.checkCalls, 3);
  assert.deepEqual(h.sleeps, [30000, 30000]);
});

test('必須チェックが1つ fail なら、PR を閉じずマージもせずに止まる', async () => {
  const h = harness({ checks: () => JSON.stringify([
    { name: 'quality', bucket: 'pass' }, { name: 'build-extension', bucket: 'pass' },
    { name: 'build-web', bucket: 'fail', link: 'https://example.test/build-web' }, { name: 'bundle-budget', bucket: 'pending' },
  ]) });
  assert.equal(await main(h.deps), 1);
  assert.ok(!h.calls.some((call) => call.startsWith('gh pr merge') || call.startsWith('gh pr close')));
  assert.match(h.outputs.join('\n'), /build-web が失敗しました[\s\S]*https:\/\/example\.test\/build-web[\s\S]*PR #301 は残してあります/);
});

test('必須でないチェック（Codexレビュー）が fail でも、4つが pass ならマージに進む', async () => {
  const checks = () => JSON.stringify([...JSON.parse(pass()), { name: 'Codexレビュー', bucket: 'fail' }]);
  const h = harness({ checks });
  assert.equal(await main(h.deps), 0);
  assert.ok(h.calls.some((call) => call.startsWith('gh pr merge 301')));
});

test('必須チェックが5分たっても報告されなければ止まる', async () => {
  const h = harness({ checks: () => '[]' });
  assert.equal(await main(h.deps), 1);
  assert.match(h.outputs.join('\n'), /必須チェックが報告されません/);
  assert.ok(!h.calls.some((call) => call.startsWith('gh pr merge')));
});

test('全体の待ちが40分を超えたら止まる（PR は残る）', async () => {
  const h = harness({ checks: () => JSON.stringify([{ name: 'quality', bucket: 'pending' }, { name: 'build-extension', bucket: 'pass' }, { name: 'build-web', bucket: 'pass' }, { name: 'bundle-budget', bucket: 'pass' }]) });
  assert.equal(await main(h.deps), 1);
  assert.match(h.outputs.join('\n'), /40 分以内に終わりませんでした/);
  assert.ok(!h.calls.some((call) => call.startsWith('gh pr merge') || call.startsWith('gh pr close')));
});

test('summarizeChecks: skipping は pass 扱い、同名が複数なら悪い方', () => {
  const s = summarizeChecks([
    { name: 'quality', bucket: 'pass' }, { name: 'quality', bucket: 'fail', link: 'L' },
    { name: 'build-extension', bucket: 'skipping' }, { name: 'build-web', bucket: 'pending' },
  ]);
  assert.deepEqual(s, { missing: ['bundle-budget'], failed: [{ name: 'quality', link: 'L' }], pending: ['build-web'] });
});

test('続きの位置1: リリース用ブランチ上で版が一致すれば push から続ける（PR が無ければ作る）', async () => {
  const h = harness({
    override: (key) => key === 'git branch --show-current' ? ok('chore/release-v0.57.2\n') : undefined,
    files: { 'package.json': '{"version":"0.57.2"}', 'CHANGELOG.md': changelog('## v0.57.2（2026-11-12）') },
  });
  assert.equal(await main(h.deps), 0);
  assert.ok(h.calls.includes('git push -u origin chore/release-v0.57.2'));
  assert.ok(!h.calls.some((call) => call.startsWith('git switch -c')));
  assert.ok(h.calls.some((call) => call.startsWith('gh pr create')));
});

test('続きの位置1: 汚れた作業ツリーなら止まる。版が不一致でも止まる', async () => {
  const dirty = harness({ override: (key) => key === 'git branch --show-current' ? ok('chore/release-v0.57.2\n') : key.startsWith('git status') ? ok(' M x\n') : undefined });
  assert.equal(await main(dirty.deps), 1);
  assert.ok(!dirty.calls.some((call) => call.startsWith('git push')));
  const mismatch = harness({ override: (key) => key === 'git branch --show-current' ? ok('chore/release-v0.57.3\n') : undefined });
  assert.equal(await main(mismatch.deps), 1);
  assert.ok(!mismatch.calls.some((call) => call.startsWith('git push')));
});

test('続きの位置2: 開いているリリース PR があればチェック待ちから続ける（--bump が違っても PR の版）', async () => {
  const h = harness({
    argv: ['--bump', 'major'],
    override: (key) => key === 'gh pr list --state open --base main --json number,headRefName'
      ? ok(JSON.stringify([{ number: 77, headRefName: 'chore/release-v0.57.3' }, { number: 5, headRefName: 'feature/x' }])) : undefined,
  });
  assert.equal(await main(h.deps), 0);
  assert.ok(h.calls.includes('gh pr checks 77 --json name,bucket,link'));
  assert.ok(h.calls.includes('gh pr merge 77 --merge --delete-branch'));
  assert.ok(!h.calls.some((call) => call.startsWith('git switch -c') || call.startsWith('gh pr create') || isBranchPush(call)));
  assert.ok(h.calls.some((call) => call === 'npm run build:release'));
  assert.match(h.outputs.join('\n'), /開いている PR の版 v0\.57\.3 を優先します/);
  assert.match(h.outputs.at(-1), /v0\.57\.3 をストアへ審査提出しました/);
});

test('続きの位置2: リリース PR が2つあれば止まる', async () => {
  const h = harness({ override: (key) => key === 'gh pr list --state open --base main --json number,headRefName'
    ? ok(JSON.stringify([{ number: 1, headRefName: 'chore/release-v0.57.3' }, { number: 2, headRefName: 'chore/release-v0.58.0' }])) : undefined });
  assert.equal(await main(h.deps), 1);
  assert.ok(!h.calls.some((call) => call.startsWith('gh pr merge')));
});

test('続きの位置3: main の版がストアに無ければ build:release から続ける', async () => {
  const h = harness({ override: (key) => key === 'git show origin/main:package.json' ? ok('{"version":"0.57.3"}') : undefined });
  assert.equal(await main(h.deps), 0);
  assert.ok(h.calls.includes('npm run build:release'));
  assert.ok(h.calls.includes('node tools/release/storeApi.mjs submit'));
  assert.ok(!h.calls.some((call) => call.startsWith('git switch') || /^gh pr (create|checks|merge)/.test(call) || isBranchPush(call)));
});

test('続きの位置3: 審査中の版が main の版と同じなら提出を飛ばす', async () => {
  const h = harness({ override: (key) => key === 'git show origin/main:package.json' ? ok('{"version":"0.57.3"}')
    : key === 'node tools/release/storeApi.mjs status --json' ? ok(storeStatus('0.57.2', '0.57.3')) : undefined });
  assert.equal(await main(h.deps), 0);
  assert.ok(!h.calls.some((call) => call === 'npm run build:release' || call.endsWith('storeApi.mjs submit')));
  assert.match(h.outputs.join('\n'), /審査提出済み/);
});

test('続きの位置4: main の版が公開中の版と同じなら新規リリース', async () => {
  const h = harness({ argv: ['--bump', 'patch', '--dry-run'] });
  assert.equal(await main(h.deps), 0);
  assert.match(h.outputs.join('\n'), /新規 v0\.57\.3/);
});

test('間に別の PR がマージされていたら、merge commit からビルドして main へ戻る', async () => {
  const h = harness({ override: (key, args, state) => {
    if (key === 'git pull --ff-only origin main') { state.head = 'later-commit'; return ok(); }
  } });
  assert.equal(await main(h.deps), 0);
  const detach = index(h.calls, 'git switch --detach merge1');
  assert.ok(detach > 0);
  assert.ok(index(h.calls, 'npm run build:release') > detach);
  assert.equal(h.calls.at(-1), 'git switch main');
});

test('ビルド失敗は提出せずに止まる', async () => {
  const h = harness({ override: (key) => key === 'npm run build:release' ? ng() : undefined });
  assert.equal(await main(h.deps), 1);
  assert.ok(!h.calls.some((call) => call.endsWith('storeApi.mjs submit')));
  assert.match(h.outputs.join('\n'), /マージは済んでいます/);
});

test('提出の終了コード3は3を返し、自動で再実行しない', async () => {
  const h = harness({ override: (key) => key === 'node tools/release/storeApi.mjs submit' ? { status: 3, stdout: '', stderr: '' } : undefined });
  assert.equal(await main(h.deps), 3);
  assert.equal(h.calls.filter((call) => call.endsWith('storeApi.mjs submit')).length, 1);
  assert.match(h.outputs.join('\n'), /結果不明です/);
});

test('--dry-run は書き込み系のコマンドを呼ばない（新規・再開のどちらでも）', async () => {
  const fresh = harness({ argv: ['--bump', 'patch', '--dry-run'] });
  assert.equal(await main(fresh.deps), 0);
  const resumed = harness({ argv: ['--bump', 'patch', '--dry-run'], override: (key) => key === 'gh pr list --state open --base main --json number,headRefName'
    ? ok(JSON.stringify([{ number: 77, headRefName: 'chore/release-v0.57.3' }])) : undefined });
  assert.equal(await main(resumed.deps), 0);
  assert.match(resumed.outputs.join('\n'), /PR 番号: #77/);
  const build = harness({ argv: ['--bump', 'patch', '--dry-run'], override: (key) => key === 'git show origin/main:package.json' ? ok('{"version":"0.57.3"}') : undefined });
  assert.equal(await main(build.deps), 0);
  for (const h of [fresh, resumed, build]) {
    assert.ok(!h.calls.some((call) => writeCommands.some((prefix) => call.startsWith(prefix))), h.calls.join('\n'));
    assert.deepEqual(h.written, {});
  }
});

test('--alias release:submit で別名の案内を1行出す', async () => {
  const h = harness({ argv: ['--bump', 'patch', '--alias', 'release:submit', '--dry-run'] });
  assert.equal(await main(h.deps), 0);
  assert.equal(h.outputs[0], '`release:submit` は `release` と同じ動作になりました');
  const major = harness({ argv: ['--bump', 'major', '--alias', 'release:submit:major', '--dry-run'] });
  await main(major.deps);
  assert.equal(major.outputs[0], '`release:submit:major` は `release:major` と同じ動作になりました');
});

test('引数: --bump が無い・不正なら終了コード2', async () => {
  for (const argv of [[], ['--bump', 'minor'], ['--bump', 'patch', '--nope']]) {
    const h = harness({ argv });
    assert.equal(await main(h.deps), 2);
    assert.equal(h.calls.length, 0);
  }
  assert.equal(parseArgs(['--bump=major', '--dry-run']).dryRun, true);
});

test('nextVersion: patch は末尾、major は中央', () => {
  assert.equal(nextVersion('0.57.2', 'patch'), '0.57.3');
  assert.equal(nextVersion('0.57.2', 'major'), '0.58.0');
});

// ---- 段6: 版タグと GitHub Release ----

const releaseView = (key) => key.startsWith('gh release view');
const noReleaseYet = (key) => releaseView(key) ? ng() : undefined;
const mainIs = (version) => (key) => key === 'git show origin/main:package.json' ? ok(`{"version":"${version}"}`) : undefined;
const firstOf = (...handlers) => (key, args, state) => {
  for (const handler of handlers) {
    const result = handler(key, args, state);
    if (result !== undefined) return result;
  }
  return undefined;
};
const citation = (doi) => `export const TIAB_REVIEW_CONCEPT_DOI = '${doi}';\n`;
const releaseCreate = (calls) => calls.filter((call) => call.startsWith('gh release create'));
const notesOf = (written) => Object.entries(written).find(([path]) => path.endsWith('release-notes-v0.57.3.md'))?.[1];

test('段6: 提出の後に merge commit へ annotated タグを打って push し、Release を作る（ファイルは添付しない）', async () => {
  const h = harness({ override: noReleaseYet, files: { 'src/lib/citation.ts': citation('10.5281/zenodo.1234567') } });
  assert.equal(await main(h.deps), 0);
  const order = [
    'node tools/release/storeApi.mjs submit',
    'git ls-remote --tags origin refs/tags/v0.57.3 refs/tags/v0.57.3^{}',
    'git tag -a v0.57.3 merge1 -m TiAb Review v0.57.3',
    'git push origin refs/tags/v0.57.3',
    'gh release view v0.57.3',
    'gh release create v0.57.3 --verify-tag --title TiAb Review v0.57.3 --notes-file .tmp/release-notes-v0.57.3.md',
  ];
  let last = -1;
  for (const call of order) {
    const at = h.calls.findIndex((candidate, i) => i > last && candidate === call);
    assert.ok(at > last, `${call} が順序どおりに呼ばれていません\n${h.calls.join('\n')}`);
    last = at;
  }
  // 添付ファイルの引数も、draft・prerelease の指定も無い。
  assert.deepEqual(releaseCreate(h.calls), ['gh release create v0.57.3 --verify-tag --title TiAb Review v0.57.3 --notes-file .tmp/release-notes-v0.57.3.md']);
  const notes = notesOf(h.written);
  assert.match(notes, /## 追加した|- 追加した/);
  assert.match(notes, /この Release に拡張機能の zip は添付しません/);
  assert.match(notes, /引用 \/ Cite: https:\/\/doi\.org\/10\.5281\/zenodo\.1234567/);
  assert.match(h.outputs.join('\n'), /v0\.57\.3 のタグと GitHub Release を作りました/);
  assert.match(h.outputs.at(-1), /v0\.57\.3 をストアへ審査提出しました/);
});

test('段6: DOI の定数が空なら引用の行を出さない', async () => {
  const h = harness({ override: noReleaseYet, files: { 'src/lib/citation.ts': citation('') } });
  assert.equal(await main(h.deps), 0);
  assert.doesNotMatch(notesOf(h.written), /引用 \/ Cite/);
});

test('段6: origin に同じコミットを指す annotated タグがあれば、タグは打たず Release だけ作る', async () => {
  const h = harness({ override: firstOf(mainIs('0.57.3'), noReleaseYet, (key) => key === 'git ls-remote --tags origin refs/tags/v0.57.3 refs/tags/v0.57.3^{}'
    ? ok('tagobject1\trefs/tags/v0.57.3\nabc\trefs/tags/v0.57.3^{}\n') : undefined) });
  assert.equal(await main(h.deps), 0);
  assert.ok(!h.calls.some((call) => call.startsWith('git tag') || call.startsWith('git push')));
  assert.equal(releaseCreate(h.calls).length, 1);
});

test('段6: origin のタグが別のコミットを指していれば、タグも Release も作らずに止まる', async () => {
  const h = harness({ override: firstOf(noReleaseYet, (key) => key.startsWith('git ls-remote --tags origin refs/tags/v0.57.3 ')
    ? ok('tagobject1\trefs/tags/v0.57.3\nother\trefs/tags/v0.57.3^{}\n') : undefined) });
  assert.equal(await main(h.deps), 1);
  assert.ok(!h.calls.some((call) => call.startsWith('git tag') || call.startsWith('git push origin refs/tags') || call.startsWith('gh release create')));
  assert.match(h.outputs.join('\n'), /origin の v0\.57\.3 が別のコミットを指しています/);
});

test('段6: 手元に同名で別のコミットを指すタグがあれば止まる', async () => {
  const h = harness({ override: firstOf(noReleaseYet, (key) => key === 'git rev-parse -q --verify refs/tags/v0.57.3^{commit}' ? ok('other\n') : undefined) });
  assert.equal(await main(h.deps), 1);
  assert.ok(!h.calls.some((call) => call.startsWith('git tag') || call.startsWith('git push origin refs/tags') || call.startsWith('gh release create')));
  assert.match(h.outputs.join('\n'), /手元の v0\.57\.3 が別のコミットを指しています/);
});

test('段6: Release が既にあれば gh release create を呼ばない', async () => {
  const h = harness();
  assert.equal(await main(h.deps), 0);
  assert.ok(h.calls.some((call) => call.startsWith('git tag -a v0.57.3')));
  assert.equal(releaseCreate(h.calls).length, 0);
});

test('段6: Release の作成に失敗したらタグは残して止まり、再実行で Release だけ作る', async () => {
  const failing = harness({ override: firstOf(noReleaseYet, (key) => key.startsWith('gh release create') ? ng() : undefined) });
  assert.equal(await main(failing.deps), 1);
  assert.ok(failing.calls.includes('git push origin refs/tags/v0.57.3'));
  // 再実行: main の版は審査中、タグは origin にある、Release は無い。
  const resumed = harness({ override: firstOf(mainIs('0.57.3'), noReleaseYet,
    (key) => key === 'node tools/release/storeApi.mjs status --json' ? ok(storeStatus('0.57.2', '0.57.3')) : undefined,
    (key) => key.startsWith('git ls-remote --tags origin refs/tags/v0.57.3 ') ? ok('abc\trefs/tags/v0.57.3\n') : undefined,
    (key) => key.startsWith('git log --first-parent') ? ok('abc\n') : undefined) });
  assert.equal(await main(resumed.deps), 0);
  assert.ok(!resumed.calls.some((call) => call.startsWith('git tag') || call.startsWith('git push')));
  assert.equal(releaseCreate(resumed.calls).length, 1);
});

test('続きの位置: 提出済みで origin にタグも Release も無い版は、段6だけを行う（ビルドも提出もしない）', async () => {
  const h = harness({ override: firstOf(mainIs('0.57.3'), noReleaseYet,
    (key) => key === 'node tools/release/storeApi.mjs status --json' ? ok(storeStatus('0.57.2', '0.57.3')) : undefined,
    (key) => key.startsWith('git log --first-parent') ? ok('c0ffee\n') : undefined) });
  assert.equal(await main(h.deps), 0);
  assert.match(h.outputs.join('\n'), /審査提出済み[\s\S]*版タグと GitHub Release/);
  assert.ok(h.calls.includes('git tag -a v0.57.3 c0ffee -m TiAb Review v0.57.3'));
  assert.ok(h.calls.includes('git push origin refs/tags/v0.57.3'));
  assert.equal(releaseCreate(h.calls).length, 1);
  assert.ok(!h.calls.some((call) => call === 'npm run build:release' || call.endsWith('storeApi.mjs submit') || /^gh pr (create|checks|merge)/.test(call)));
});

test('続きの位置: 公開中の版にタグが無いときも段6から続ける。dry-run は何も書かない', async () => {
  const override = firstOf(mainIs('0.57.3'), noReleaseYet,
    (key) => key === 'node tools/release/storeApi.mjs status --json' ? ok(storeStatus('0.57.3')) : undefined);
  const dry = harness({ argv: ['--bump', 'patch', '--dry-run'], override });
  assert.equal(await main(dry.deps), 0);
  assert.match(dry.outputs.join('\n'), /ストアで公開中です。版タグと GitHub Release の作成から/);
  assert.ok(!dry.calls.some((call) => writeCommands.some((prefix) => call.startsWith(prefix)) || call.startsWith('git tag') || call.startsWith('git push') || call.startsWith('gh release create')));
  assert.deepEqual(dry.written, {});
});

test('続きの位置: TAG_FROM_AFTER_VERSION 以下の版は、タグも Release も無くても段6を再開しない', async () => {
  assert.equal(TAG_FROM_AFTER_VERSION, '0.57.2');
  const override = firstOf(noReleaseYet, (key) => key === 'node tools/release/storeApi.mjs status --json' ? ok(storeStatus('0.57.2')) : undefined);
  const h = harness({ argv: ['--bump', 'patch', '--dry-run'], override: firstOf(mainIs('0.57.2'), override) });
  assert.equal(await main(h.deps), 0);
  assert.doesNotMatch(h.outputs.join('\n'), /版タグと GitHub Release の作成から/);
  assert.match(h.outputs.join('\n'), /新規 v0\.57\.3/);
  assert.ok(!h.calls.some((call) => call.startsWith('git tag') || call.startsWith('git push origin refs/tags') || call.startsWith('gh release create')));
  // 提出済み（審査中）でも同じ。
  const submitted = harness({ override: firstOf(mainIs('0.57.2'), noReleaseYet, (key) => key === 'node tools/release/storeApi.mjs status --json' ? ok(storeStatus('0.57.1', '0.57.2')) : undefined) });
  assert.equal(await main(submitted.deps), 0);
  assert.match(submitted.outputs.join('\n'), /審査提出済み/);
  assert.ok(!submitted.calls.some((call) => call.startsWith('git tag') || call.startsWith('gh release')));
});

test('段6: TAG_FROM_AFTER_VERSION 以下の版をビルドから続けても、タグは打たない', async () => {
  // 下限と同じ版は提出まで進めても段6の対象外（過去の版にはタグを打たない）。
  const h = harness({ override: firstOf(mainIs(TAG_FROM_AFTER_VERSION), (key) => key === 'node tools/release/storeApi.mjs status --json' ? ok(storeStatus('0.57.1')) : undefined) });
  assert.equal(await main(h.deps), 0);
  assert.ok(h.calls.includes('node tools/release/storeApi.mjs submit'));
  assert.ok(!h.calls.some((call) => call.startsWith('git tag') || call.startsWith('git push origin refs/tags') || call.startsWith('gh release')));
});
