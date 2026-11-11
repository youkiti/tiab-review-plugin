// リリースの1コマンド: 版上げ PR の作成 → 必須チェック待ち → マージ → ストア用ビルドと審査提出 → 版タグと GitHub Release。
// 起動: node tools/release/release.mjs --bump patch|major [--dry-run] [--alias <npm script 名>]
// 途中で止まっても、同じコマンドを再実行すると続きから進む。続きの位置は状態ファイルでなく、
// GitHub（開いているリリース PR、main の版）とストア（公開中・審査中の版）の実際の状態から決める。
// 外部コマンドはすべて run() 経由で呼ぶ。テストは run を差し替えて、実際の git・gh・ストアを呼ばずに検査する。
import { readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions } from './storeApi.mjs';
import { extractChangelogSection, readConceptDoi, buildReleaseNotes } from './release-notes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// build-check.yml のジョブ名と一致させる。ruleset `protect main` の必須チェック名も同じ。
export const REQUIRED_CHECKS = ['quality', 'build-extension', 'build-web', 'bundle-budget'];
export const RELEASE_BRANCH_PREFIX = 'chore/release-v';
const POLL_MS = 30_000;
const APPEAR_LIMIT_MS = 5 * 60_000;
const TOTAL_LIMIT_MS = 40 * 60_000;
const RERUN_NOTE = '同じコマンドを再実行すると、ここから続きます。';
const STORE_API = 'tools/release/storeApi.mjs';
// 版タグと GitHub Release は、この版より新しい版にだけ作る。過去の版にはタグを打たない（版とコミットの対応は文書に載せる）。
// 段6の再開（提出済みの版にタグか Release が無いとき）の下限でもある。実装時点の main の package.json の版。
export const TAG_FROM_AFTER_VERSION = '0.57.2';
const CITATION_TS = 'src/lib/citation.ts';
const REPO_URL = 'https://github.com/youkiti/tiab-review-plugin';

export class StopError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const red = (text) => `\u001b[31m${text}\u001b[0m`;
const stop = (reason, { rerun = true, code = 1 } = {}) => {
  throw new StopError(rerun ? `${reason}\n${RERUN_NOTE}` : reason, code);
};

// 外部コマンドの本物の呼び出し。npm は Windows では npm.cmd を shell: true で起動する（Node 20.12 以降は .cmd を shell なしで起動できない）。
export function defaultRun(cmd, args, { capture = false } = {}) {
  const useShell = process.platform === 'win32' && cmd === 'npm';
  const result = spawnSync(useShell ? 'npm.cmd' : cmd, args, {
    cwd: root,
    shell: useShell,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function parseArgs(argv) {
  const options = { bump: undefined, dryRun: false, alias: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help') options.help = true;
    else if (arg === '--bump') options.bump = argv[++i];
    else if (arg.startsWith('--bump=')) options.bump = arg.slice('--bump='.length);
    else if (arg === '--alias') options.alias = argv[++i];
    else if (arg.startsWith('--alias=')) options.alias = arg.slice('--alias='.length);
    else throw new StopError(`不明な引数です: ${arg}`, 2);
  }
  if (!options.help && !['patch', 'major'].includes(options.bump)) throw new StopError('--bump patch か --bump major を指定してください', 2);
  return options;
}

// bump-version.ps1 と同じ規則: 0.<major>.<minor>。patch は末尾、major は中央の数字を上げる。
export function nextVersion(current, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) throw new StopError(`package.json の版が X.Y.Z 形式ではありません: ${current}`);
  const [lead, major, minor] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return bump === 'major' ? `${lead}.${major + 1}.0` : `${lead}.${major}.${minor + 1}`;
}

// 「未リリース」の見出しをちょうど1つ、版の節の見出しに置き換える。改行と BOM は読んだままにする。
export function replaceChangelogHeading(text, version, date) {
  const pattern = /^## 未リリース(?: \/ Unreleased)?(?=\r?$)/gm;
  const count = (text.match(pattern) ?? []).length;
  if (count !== 1) {
    throw new StopError(count === 0
      ? 'CHANGELOG.md に「未リリース」の節がありません。利用者に見える変更を書いてから再実行してください'
      : `CHANGELOG.md に「未リリース」の見出しが ${count} 個あります。1つにしてから再実行してください`);
  }
  return text.replace(pattern, `## v${version}（${date}）`);
}

export function changelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## v${version}（`));
  if (start < 0) return '';
  let end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n').trim();
}

const localDate = (ms) => {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// チェックの一覧から必須4つの状態を決める。同名が複数あれば悪い方を採る。
export function summarizeChecks(checks) {
  const result = { missing: [], failed: [], pending: [] };
  for (const name of REQUIRED_CHECKS) {
    const entries = checks.filter((check) => check.name === name);
    if (entries.length === 0) { result.missing.push(name); continue; }
    const failed = entries.find((entry) => entry.bucket === 'fail' || entry.bucket === 'cancel');
    if (failed) { result.failed.push({ name, link: failed.link ?? '' }); continue; }
    if (entries.some((entry) => entry.bucket !== 'pass' && entry.bucket !== 'skipping')) result.pending.push(name);
  }
  return result;
}

function parseJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

export async function main({
  argv = process.argv.slice(2),
  run = defaultRun,
  readFile = (path) => readFileSync(resolve(root, path), 'utf8'),
  writeFile = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); },
  removeFile = (path) => rmSync(path, { force: true }),
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  now = () => Date.now(),
  output = console.log,
  tmp = tmpdir(),
} = {}) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      output('使い方: node tools/release/release.mjs --bump patch|major [--dry-run]\n--dry-run: 何も変えず、続きの位置と新しい版だけを表示します');
      return 0;
    }
    if (options.alias) output(`\`${options.alias}\` は \`release${options.bump === 'major' ? ':major' : ''}\` と同じ動作になりました`);
    return await release(options, { run, readFile, writeFile, removeFile, sleep, now, output, tmp });
  } catch (error) {
    if (error instanceof StopError) {
      output(red(error.message));
      return error.code;
    }
    output(red(`予期しないエラー: ${error?.message ?? error}\n${RERUN_NOTE}`));
    return 1;
  }
}

async function release(options, { run, readFile, writeFile, removeFile, sleep, now, output, tmp }) {
  const capture = (cmd, args) => run(cmd, args, { capture: true });
  const git = (args) => capture('git', args);
  const text = (result) => (result.stdout ?? '').trim();

  async function requireGh() {
    const version = await capture('gh', ['--version']);
    const auth = version.status === 0 ? await capture('gh', ['auth', 'status']) : version;
    if (auth.status !== 0) stop('gh CLI が無いか、ログインしていません。README の手順で導入して `gh auth login` してください');
  }

  async function listReleasePrs() {
    const listed = await capture('gh', ['pr', 'list', '--state', 'open', '--base', 'main', '--json', 'number,headRefName']);
    if (listed.status !== 0) stop('開いている PR の一覧を取得できませんでした');
    return parseJson(listed.stdout, []).filter((pr) => String(pr.headRefName ?? '').startsWith(RELEASE_BRANCH_PREFIX));
  }

  async function requireMainSynced() {
    const branch = text(await git(['branch', '--show-current']));
    if (branch !== 'main') stop(`main ブランチで実行してください（現在: ${branch || 'detached HEAD'}。git switch main してから）`);
    const dirty = await git(['status', '--porcelain', '--ignore-submodules=dirty']);
    if (dirty.status !== 0) stop('作業ツリーを確認できません');
    if (text(dirty)) stop('作業ツリーに未コミットの変更があります');
    const head = text(await git(['rev-parse', 'HEAD']));
    const origin = text(await git(['rev-parse', 'origin/main']));
    if (!head || head !== origin) stop('HEAD と origin/main が一致しません。未 push または要 pull の状態です（git pull --ff-only origin main など）');
  }

  function requireEnv() {
    let env = '';
    try { env = readFile('.env'); } catch { /* 無ければ下で止める */ }
    const line = env.split(/\r?\n/).map((l) => /^\s*WEBAUTH_CLIENT_ID\s*=(.*)$/.exec(l)).find(Boolean);
    const value = line ? line[1].trim().replace(/^(['"])(.*)\1$/, '$2').trim() : '';
    if (!value) stop('.env に WEBAUTH_CLIENT_ID がありません（ストア用ビルドが最後の段で失敗するため、先に止めました）。値を設定してください');
  }

  async function requireSubmittable() {
    const result = await run('node', [STORE_API, 'status', '--require-submittable']);
    if (result.status !== 0) stop('ストアの認証または提出可否の確認に失敗しました');
  }

  // 段1の1〜4（何も変えない）。
  async function prerequisites() {
    await requireMainSynced();
    requireEnv();
    await requireSubmittable();
  }

  // 段6の入口: origin にタグが無い、または GitHub Release が無い。
  async function remoteTag(version) {
    const ref = `refs/tags/v${version}`;
    const listed = await git(['ls-remote', '--tags', 'origin', ref, `${ref}^{}`]);
    if (listed.status !== 0) stop('origin のタグを確認できません');
    const entries = text(listed).split(/\r?\n/).filter(Boolean).map((line) => {
      const [oid, name] = line.split(/\s+/);
      return { oid, peeled: name?.endsWith('^{}') ?? false };
    });
    // annotated タグは `^{}` の行がコミット、軽量タグは1行目がコミット。
    const entry = entries.find((e) => e.peeled) ?? entries[0];
    return entry?.oid ?? null;
  }

  async function tagStageIncomplete(version) {
    if (!(await remoteTag(version))) return true;
    return (await capture('gh', ['release', 'view', `v${version}`])).status !== 0;
  }

  // 段0: 続きの位置を決める。
  await requireGh();
  const fetched = await git(['fetch', 'origin', 'main', '--tags']);
  if (fetched.status !== 0) stop('origin/main の取得に失敗しました');
  const branch = text(await git(['branch', '--show-current']));
  const packageVersion = parseJson(readFile('package.json'), {}).version;
  let position;
  const onRelease = new RegExp(`^${RELEASE_BRANCH_PREFIX.replace('/', '\\/')}(\\d+\\.\\d+\\.\\d+)$`).exec(branch);
  if (onRelease) {
    if (onRelease[1] !== packageVersion) {
      stop(`リリース用ブランチ ${branch} の版上げが済んでいません（package.json は ${packageVersion}）。このブランチを消して（git switch main してから git branch -D ${branch}）再実行してください`, { rerun: false });
    }
    position = { kind: 'push', version: onRelease[1], branch };
  } else {
    const prs = await listReleasePrs();
    if (prs.length > 1) stop(`開いているリリース PR が ${prs.length} 件あります（${prs.map((pr) => `#${pr.number}`).join('、')}）。1件にしてから再実行してください`, { rerun: false });
    if (prs.length === 1) {
      position = { kind: 'wait', pr: prs[0].number, version: prs[0].headRefName.slice(RELEASE_BRANCH_PREFIX.length), branch: prs[0].headRefName };
    } else {
      const shown = await git(['show', 'origin/main:package.json']);
      const mainVersion = parseJson(shown.stdout, {}).version;
      const statusResult = await capture('node', [STORE_API, 'status', '--json']);
      const store = parseJson(statusResult.stdout, undefined);
      if (statusResult.status !== 0 || !store) stop('ストアの認証または状況の確認に失敗しました');
      const published = (store.publishedItemRevisionStatus?.distributionChannels ?? []).map((c) => c.crxVersion);
      const submitted = (store.submittedItemRevisionStatus?.distributionChannels ?? []).map((c) => c.crxVersion);
      const shipped = mainVersion && [...published, ...submitted].includes(mainVersion);
      if (shipped && compareVersions(mainVersion, TAG_FROM_AFTER_VERSION) > 0 && await tagStageIncomplete(mainVersion)) {
        position = { kind: 'tag', version: mainVersion, inReview: submitted.includes(mainVersion) };
      } else if (mainVersion && submitted.includes(mainVersion)) position = { kind: 'submitted', version: mainVersion };
      else if (mainVersion && ![...published, ...submitted].includes(mainVersion) && [...published, ...submitted].every((v) => compareVersions(mainVersion, v) > 0)) {
        position = { kind: 'build', version: mainVersion };
      } else position = { kind: 'new' };
    }
  }

  const describe = {
    push: `続きの位置: リリース用ブランチ ${position.branch} の push から（v${position.version}）`,
    wait: `続きの位置: 開いているリリース PR #${position.pr} の必須チェック待ちから（v${position.version}）`,
    build: `続きの位置: v${position.version} はマージ済みで未提出。ストア用ビルドから`,
    tag: `続きの位置: v${position.version} は${position.inReview ? '審査提出済み' : 'ストアで公開中'}です。版タグと GitHub Release の作成から`,
    submitted: `v${position.version} は審査提出済みです。続きの作業はありません`,
    new: '続きの位置: 新規リリース',
  }[position.kind];
  output(describe);

  // 段1
  let version;
  if (position.kind === 'submitted') {
    return 0;
  } else if (position.kind === 'tag') {
    version = position.version;
  } else if (position.kind === 'push') {
    const dirty = await git(['status', '--porcelain', '--ignore-submodules=dirty']);
    if (dirty.status !== 0 || text(dirty)) stop('作業ツリーに未コミットの変更があります');
    version = position.version;
  } else if (position.kind === 'wait') {
    await prerequisites();
    version = position.version;
    if (position.version !== nextVersion(packageVersion, options.bump) && options.bump) {
      output(`開いている PR の版 v${position.version} を優先します（指定した --bump とは別の版です）`);
    }
  } else if (position.kind === 'build') {
    await prerequisites();
    version = position.version;
  } else {
    await prerequisites();
    const changelog = readFile('CHANGELOG.md');
    replaceChangelogHeading(changelog, '0.0.0', '0000-00-00');
    version = nextVersion(packageVersion, options.bump);
    const heads = await git(['ls-remote', '--heads', 'origin', `${RELEASE_BRANCH_PREFIX}${version}`]);
    const tags = await git(['ls-remote', '--tags', 'origin', `refs/tags/v${version}`]);
    if (heads.status !== 0 || tags.status !== 0) stop('origin のブランチとタグを確認できません');
    if (text(heads)) stop(`origin に ${RELEASE_BRANCH_PREFIX}${version} ブランチが既にあります`, { rerun: false });
    if (text(tags)) stop(`origin に v${version} タグが既にあります`, { rerun: false });
    position = { kind: 'new', version, branch: `${RELEASE_BRANCH_PREFIX}${version}` };
  }
  const branchName = position.branch ?? `${RELEASE_BRANCH_PREFIX}${version}`;

  if (options.dryRun) {
    output(position.kind === 'new' ? `新規 v${version}（dry-run のため何も変更しません）` : `v${version}（dry-run のため何も変更しません）`);
    if (position.pr) output(`PR 番号: #${position.pr}`);
    return 0;
  }

  if (position.kind === 'tag') {
    await tagAndRelease(version, undefined);
    return 0;
  }

  let pr = position.pr;
  if (position.kind === 'new') {
    // 段2: ブランチ作成、CHANGELOG の版の節、版上げ。
    const switched = await git(['switch', '-c', branchName, 'origin/main']);
    if (switched.status !== 0) stop(`ブランチ ${branchName} を作れませんでした`);
    const original = readFile('CHANGELOG.md');
    writeFile(resolve(root, 'CHANGELOG.md'), replaceChangelogHeading(original, version, localDate(now())));
    const failedStage2 = (reason) => stop(`${reason}\n途中まで進んだブランチが手元に残っています。git switch main してから git branch -D ${branchName} で消して、再実行してください`, { rerun: false });
    if ((await git(['add', 'CHANGELOG.md'])).status !== 0) failedStage2('CHANGELOG.md のステージに失敗しました');
    if ((await git(['commit', '-m', `docs: CHANGELOG に v${version} を書く`])).status !== 0) failedStage2('CHANGELOG の commit に失敗しました');
    const bumped = await run('powershell', ['-ExecutionPolicy', 'Bypass', '-File', 'scripts/bump-version.ps1', '-SetVersion', version]);
    if (bumped.status !== 0) failedStage2('版上げに失敗しました');
  }
  if (position.kind === 'new' || position.kind === 'push') {
    const pushed = await run('git', ['push', '-u', 'origin', branchName]);
    if (pushed.status !== 0) stop('push に失敗しました。origin の状態を確認してください');
  }

  if (position.kind === 'new' || position.kind === 'push') {
    // 段3の1: PR 作成（同じブランチの PR が既にあれば再利用する）。
    const existing = (await listReleasePrs()).find((candidate) => candidate.headRefName === branchName);
    if (existing) pr = existing.number;
    else {
      const body = `${changelogSection(readFile('CHANGELOG.md'), version)}\n\n\`npm run release\` が作成した PR です。必須チェックが通ると自動でマージします。\n`;
      const bodyFile = join(tmp, `release-pr-body-${version}.md`);
      writeFile(bodyFile, body);
      let created;
      try {
        created = await capture('gh', ['pr', 'create', '--base', 'main', '--head', branchName, '--title', `chore: リリース v${version}`, '--body-file', bodyFile]);
      } finally {
        removeFile(bodyFile);
      }
      if (created.status !== 0) stop('PR の作成に失敗しました。ブランチは push 済みです');
      const number = /\/pull\/(\d+)/.exec(created.stdout ?? '');
      pr = number ? Number(number[1]) : (await listReleasePrs()).find((candidate) => candidate.headRefName === branchName)?.number;
      if (!pr) stop('作成した PR の番号を読み取れませんでした。開いている PR を確認してください');
      output(`PR #${pr} を作成しました`);
    }
  }

  let mergeSha;
  if (pr) {
    await waitForChecks(pr);
    mergeSha = await mergePr(pr);
  }
  await buildAndSubmit(version, mergeSha);
  return 0;

  // 段6: 対象のコミットを決める。段4の merge commit があればそれ。無ければ（再開）main の first-parent で
  // package.json を最後に変えたコミット（その版の merge commit）。見つからなければ origin/main の先頭。
  async function releaseCommit(newVersion, sha) {
    if (sha) return sha;
    const found = text(await git(['log', '--first-parent', '-n', '1', '--format=%H', 'origin/main', '--', 'package.json']));
    const target = found || text(await git(['rev-parse', 'origin/main']));
    if (!target) stop('版タグを打つコミットを決められません');
    const shown = await git(['show', `${target}:package.json`]);
    const atTarget = shown.status === 0 ? parseJson(shown.stdout, {}).version : undefined;
    if (atTarget && atTarget !== newVersion) stop(`コミット ${target.slice(0, 7)} の package.json の版は ${atTarget} で、v${newVersion} ではありません。タグを打たずに止まりました`, { rerun: false });
    return target;
  }

  async function readAtCommit(commit, path) {
    const shown = await git(['show', `${commit}:${path}`]);
    if (shown.status === 0 && (shown.stdout ?? '') !== '') return shown.stdout;
    try { return readFile(path); } catch { return ''; }
  }

  async function tagAndRelease(newVersion, sha) {
    const tag = `v${newVersion}`;
    const ref = `refs/tags/${tag}`;
    const commit = await releaseCommit(newVersion, sha);

    // タグ: origin に既にあれば、同じコミットを指すときだけ先へ進む。
    const remote = await remoteTag(newVersion);
    if (remote) {
      if (remote !== commit) stop(`origin の ${tag} が別のコミットを指しています（origin: ${remote.slice(0, 7)}、この版: ${commit.slice(0, 7)}）。タグは動かしません`, { rerun: false });
    } else {
      const local = text(await git(['rev-parse', '-q', '--verify', `${ref}^{commit}`]));
      if (local && local !== commit) stop(`手元の ${tag} が別のコミットを指しています（手元: ${local.slice(0, 7)}、この版: ${commit.slice(0, 7)}）。確認して git tag -d ${tag} してから再実行してください`, { rerun: false });
      if (!local && (await git(['tag', '-a', tag, commit, '-m', `TiAb Review ${tag}`])).status !== 0) stop(`タグ ${tag} を作れませんでした`);
      if ((await run('git', ['push', 'origin', ref])).status !== 0) stop(`タグ ${tag} の push に失敗しました。手元のタグは残してあります`);
    }

    // GitHub Release: 無いときだけ作る。draft・prerelease にしない（Zenodo は published だけを保存する）。ファイルは添付しない。
    const releaseUrl = `${REPO_URL}/releases/tag/${tag}`;
    if ((await capture('gh', ['release', 'view', tag])).status === 0) {
      output(`${tag} の GitHub Release は既にあります: ${releaseUrl}`);
      return;
    }
    const changelog = await readAtCommit(commit, 'CHANGELOG.md');
    const section = extractChangelogSection(changelog, newVersion);
    if (section === null) output(red(`CHANGELOG.md に v${newVersion} の節が見つかりません。リリースノートは案内の行だけになります`));
    const notesPath = `.tmp/release-notes-${tag}.md`;
    writeFile(resolve(root, notesPath), buildReleaseNotes(section, readConceptDoi(await readAtCommit(commit, CITATION_TS))));
    let created;
    try {
      created = await capture('gh', ['release', 'create', tag, '--verify-tag', '--title', `TiAb Review ${tag}`, '--notes-file', notesPath]);
    } finally {
      removeFile(resolve(root, notesPath));
    }
    if (created.status !== 0) stop(`GitHub Release の作成に失敗しました。タグは push 済みです。原因を解消して同じコマンドを再実行すると、Release の作成から続きます`, { rerun: false });
    output(`${tag} のタグと GitHub Release を作りました: ${/https?:\/\/\S+/.exec(created.stdout ?? '')?.[0] ?? releaseUrl}`);
  }

  // 段3の2: 必須4つだけを見て待つ。--watch は必須でないチェックの失敗でも非0になるため使わない。
  async function waitForChecks(number) {
    const started = now();
    for (;;) {
      const listed = await capture('gh', ['pr', 'checks', String(number), '--json', 'name,bucket,link']);
      const checks = parseJson(listed.stdout, []);
      const summary = summarizeChecks(Array.isArray(checks) ? checks : []);
      if (summary.failed.length > 0) {
        const first = summary.failed[0];
        stop(`必須チェック ${first.name} が失敗しました（${first.link}）。PR #${number} は残してあります。原因を直してこのブランチに push し、チェックが通ったら同じコマンドを再実行してください（マージから続きます）`, { rerun: false });
      }
      const elapsed = now() - started;
      if (summary.missing.length === 0 && summary.pending.length === 0) return;
      if (summary.missing.length > 0 && elapsed >= APPEAR_LIMIT_MS) stop(`必須チェックが報告されません（${summary.missing.join('、')}）。PR #${number} は残してあります`);
      if (elapsed >= TOTAL_LIMIT_MS) stop(`必須チェックが ${TOTAL_LIMIT_MS / 60_000} 分以内に終わりませんでした。PR #${number} は残してあります（再実行でチェック待ちから続きます）`, { rerun: false });
      output(`待機中: ${[...summary.missing, ...summary.pending].join('、')}`);
      await sleep(POLL_MS);
    }
  }

  // 段4
  async function mergePr(number) {
    const merged = await run('gh', ['pr', 'merge', String(number), '--merge', '--delete-branch']);
    if (merged.status !== 0) stop(`PR #${number} のマージに失敗しました。PR は残してあります。原因を解消して同じコマンドを再実行すると、マージから続きます`, { rerun: false });
    const viewed = await capture('gh', ['pr', 'view', String(number), '--json', 'state,mergeCommit']);
    const info = parseJson(viewed.stdout, {});
    if (info.state !== 'MERGED' || !info.mergeCommit?.oid) stop(`PR #${number} がマージ済みになっていません。状態を確認してください`, { rerun: false });
    if ((await git(['switch', 'main'])).status !== 0) stop('main へ切り替えられませんでした。切り替えてから同じコマンドを再実行すると、ビルドから続きます', { rerun: false });
    if ((await git(['pull', '--ff-only', 'origin', 'main'])).status !== 0) stop('main の取り込みに失敗しました。マージは済んでいます。git pull --ff-only origin main をしてから同じコマンドを再実行すると、ビルドから続きます', { rerun: false });
    return info.mergeCommit.oid;
  }

  // 段5
  async function buildAndSubmit(newVersion, sha) {
    let detached = false;
    let tagged = false;
    if (sha && text(await git(['rev-parse', 'HEAD'])) !== sha) {
      // 間に別の PR がマージされた。ビルドは merge commit から作る。
      if ((await git(['switch', '--detach', sha])).status !== 0) stop('merge commit へ切り替えられませんでした。マージは済んでいます', { rerun: false });
      detached = true;
    }
    try {
      const built = await run('npm', ['run', 'build:release']);
      if (built.status !== 0) stop('ストア用ビルドに失敗しました。マージは済んでいます。原因を直して同じコマンドを再実行すると、ビルドから続きます', { rerun: false });
      const submitted = await run('node', [STORE_API, 'submit']);
      if (submitted.status === 3) {
        stop('結果不明です。`npm run store:status` で状況を確かめてから、同じコマンドを再実行してください（提出済みなら提出は飛ばします）', { rerun: false, code: 3 });
      }
      if (submitted.status !== 0) stop('ストアへの提出に失敗しました。理由は上の出力を確認してください。原因を解消して同じコマンドを再実行すると、提出から続きます', { rerun: false });
      // 段6: 提出の後に、同じ merge commit へ版タグと GitHub Release を作る（main へ戻る前の同じ流れの中で行う）。
      tagged = compareVersions(newVersion, TAG_FROM_AFTER_VERSION) > 0;
      if (tagged) await tagAndRelease(newVersion, sha);
    } finally {
      if (detached) await git(['switch', 'main']);
    }
    output(`v${newVersion} をストアへ審査提出しました${tagged ? '。版タグと GitHub Release も作成済みです' : ''}`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
