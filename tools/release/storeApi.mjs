// Chrome Web Store API v2 で公開状況の確認と提出用 zip のアップロード・審査提出を行う。
// 使い方: node tools/release/storeApi.mjs status|submit [--help]
// 書き込みは自動再実行しない。通信が途切れた場合は状況を確認してから判断する。
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { parse } from 'dotenv';

const root = fileURLToPath(new URL('../../', import.meta.url));
const itemId = 'alejlnlfflogpnabpbplmnojgoeeabij';
const keys = ['CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN', 'CWS_PUBLISHER_ID'];
const unknownResult = '結果不明。npm run store:status で状況を確認してから判断する。自動では再実行しない';

export class StoreError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

// URL は値の置換前に除去する。JSON 中のエスケープ済みの値も伏せる。
export function redact(text, secrets) {
  let result = String(text).replace(/https?:\/\/(?:chromewebstore|oauth2)\.googleapis\.com[^\s"'<>]*/g, '<CWS_REQUEST_URL>');
  const replacements = Object.entries(secrets).flatMap(([key, value]) => {
    if (!value) return [];
    return [String(value), JSON.stringify(String(value)).slice(1, -1), encodeURIComponent(value)]
      .map((candidate) => [candidate, `<${key}>`]);
  }).sort((a, b) => b[0].length - a[0].length);
  // 一度の置換にして、置換先のキー名を別の秘密値として再置換しない。
  if (replacements.length) {
    const escaped = replacements.map(([value]) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    result = result.replace(new RegExp(escaped.join('|'), 'g'), (value) => replacements.find(([candidate]) => candidate === value)[1]);
  }
  return result;
}

export function parseArgs(args) {
  const [command, ...rest] = args;
  if (args.length === 1 && command === '--help') return { help: true };
  if (!['status', 'submit'].includes(command)) throw new StoreError('サブコマンドは status または submit を指定してください', 2);
  const options = { command };
  const flags = command === 'status' ? ['--json', '--require-submittable'] : ['--dry-run'];
  for (const arg of rest) {
    if (arg === '--help') options.help = true;
    else if (flags.includes(arg)) options[arg.slice(2)] = true;
    else if (arg.startsWith('--env-file=') || (command === 'submit' && arg.startsWith('--zip='))) {
      const separator = arg.indexOf('=');
      if (!arg.slice(separator + 1)) throw new StoreError('パスを空にできません', 2);
      options[arg.slice(2, separator)] = arg.slice(separator + 1);
    } else throw new StoreError('未知の引数です。--help で使い方を確認してください', 2);
  }
  return options;
}

export function loadCredentials(env, envPath, readFile, secrets) {
  let fileEnv = {};
  try {
    fileEnv = parse(readFile(envPath));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new StoreError('環境設定ファイルを読めません', 2);
  }
  // 環境変数で上書きした値だけでなく、ファイル側の値も出力から除去する。
  for (const key of keys) secrets[`${key}_FILE`] = fileEnv[key];
  let sharedEnv = {};
  const sharedPath = env.CWS_ENV_FILE ?? fileEnv.CWS_ENV_FILE;
  if (sharedPath) {
    try {
      sharedEnv = parse(readFile(resolve(dirname(envPath), sharedPath)));
    } catch {
      throw new StoreError('CWS_ENV_FILE が指す環境設定ファイルを読めません', 2);
    }
  }
  for (const key of keys) secrets[`${key}_SHARED`] = sharedEnv[key];
  const credentials = Object.fromEntries(keys.map((key) => [key, env[key] ?? fileEnv[key] ?? sharedEnv[key]]));
  Object.assign(secrets, credentials);
  const missing = keys.filter((key) => !credentials[key]?.trim());
  if (missing.length) throw new StoreError(`不足している設定: ${missing.join(', ')}`, 2);
  return credentials;
}

export function submittableReason(status) {
  if (status.takenDown) return '公開停止中（takenDown）のため提出できません';
  const state = status.submittedItemRevisionStatus?.state;
  if (['PENDING_REVIEW', 'STAGED'].includes(state)) return `提出済みの版が ${state} のため提出できません`;
  return '';
}

export function compareVersions(left, right) {
  if (![left, right].every((value) => /^\d+(?:\.\d+){2,3}$/.test(value))) throw new StoreError('版の形式を判定できません');
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0n) > (b[i] ?? 0n)) return 1;
    if ((a[i] ?? 0n) < (b[i] ?? 0n)) return -1;
  }
  return 0;
}

export function readZipVersion(bytes) {
  const unreadable = () => new StoreError('zip 内の manifest.json から版を読み取れません', 2);
  try {
    const checkRange = (offset, length, end = bytes.length) => {
      if (offset < 0 || length < 0 || offset + length > end) throw unreadable();
    };
    let eocd = -1;
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - 0xffff); offset--) {
      if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) {
        eocd = offset;
        break;
      }
    }
    if (eocd < 0) throw unreadable();
    const count = bytes.readUInt16LE(eocd + 10);
    let offset = bytes.readUInt32LE(eocd + 16);
    const directoryEnd = offset + bytes.readUInt32LE(eocd + 12);
    checkRange(offset, directoryEnd - offset, eocd);
    if (bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0 || bytes.readUInt16LE(eocd + 8) !== count) throw unreadable();
    let manifest;
    for (let i = 0; i < count; i++) {
      checkRange(offset, 46, directoryEnd);
      if (bytes.readUInt32LE(offset) !== 0x02014b50) throw unreadable();
      const nameLength = bytes.readUInt16LE(offset + 28);
      const entryLength = 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
      checkRange(offset, entryLength, directoryEnd);
      if (bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8') === 'manifest.json') {
        const method = bytes.readUInt16LE(offset + 10);
        const size = bytes.readUInt32LE(offset + 20);
        const local = bytes.readUInt32LE(offset + 42);
        checkRange(local, 30, bytes.readUInt32LE(eocd + 16));
        if (bytes.readUInt32LE(local) !== 0x04034b50 || (bytes.readUInt16LE(offset + 8) & 1)) throw unreadable();
        // データ記述子つき zip でも読めるよう、圧縮方式とサイズはセントラルディレクトリから取得する。
        const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
        checkRange(start, size, bytes.readUInt32LE(eocd + 16));
        const data = bytes.subarray(start, start + size);
        if (method === 0) manifest = data;
        else if (method === 8) manifest = inflateRawSync(data);
        else throw unreadable();
      }
      offset += entryLength;
    }
    if (!manifest || offset !== directoryEnd) throw unreadable();
    const version = JSON.parse(manifest.toString('utf8').replace(/^\uFEFF/, '')).version;
    if (typeof version !== 'string') throw unreadable();
    return version;
  } catch {
    throw unreadable();
  }
}

export function selectZip(zip, readFile, repoRoot = root) {
  try {
    const path = zip ? resolve(zip) : resolve(repoRoot, 'dist.zip');
    const packageVersion = JSON.parse(readFile(resolve(repoRoot, 'package.json'), 'utf8')).version;
    const bytes = readFile(path);
    if (!bytes.length) throw new StoreError('zip が空です', 2);
    const version = readZipVersion(bytes);
    if (version !== packageVersion) throw new StoreError('zip 内の manifest.json の版と package.json の版が一致しません', 2);
    return { path, bytes, version };
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError('zip または package.json を読み取れません', 2);
  }
}

function exceptionText(error, seen = new Set()) {
  if (seen.has(error)) return '';
  seen.add(error);
  return `${error?.message ?? String(error)}${error?.cause ? ` / ${exceptionText(error.cause, seen)}` : ''}`;
}

export function createClient({ credentials, fetchImpl, sleep, secrets }) {
  const resource = `publishers/${encodeURIComponent(credentials.CWS_PUBLISHER_ID)}/items/${itemId}`;
  const base = 'https://chromewebstore.googleapis.com';
  let token;
  async function request(url, init, { retry = false, timeout, operation, tokenRequest = false }) {
    for (let attempt = 0; attempt < (retry ? 3 : 1); attempt++) {
      let response;
      let data;
      let readError;
      try {
        response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeout) });
        try {
          data = await response.json();
        } catch (error) {
          readError = error;
        }
      } catch (error) {
        if (retry && attempt < 2) { await sleep([1000, 3000][attempt]); continue; }
        throw new StoreError(`${operation}: ${retry ? '通信に失敗しました' : unknownResult}。${exceptionText(error)}`, retry ? 1 : 3);
      }
      if (retry && attempt < 2 && (response.status >= 500 || response.status === 429 || (response.ok && readError))) {
        await sleep([1000, 3000][attempt]);
        continue;
      }
      if (!response.ok) {
        if (tokenRequest && data?.error === 'invalid_grant') {
          throw new StoreError('リフレッシュトークンが失効または取り消されています（invalid_grant）。OAuth 同意画面が「テスト中」だと 7 日で失効します。OAuth Playground（https://developers.google.com/oauthplayground）でスコープ https://www.googleapis.com/auth/chromewebstore を再承認し、.env の CWS_REFRESH_TOKEN を入れ直してください。CWS_ENV_FILE で共有している場合は、その共有元の .env の CWS_REFRESH_TOKEN を入れ直してください。詳細: tools/release/README.md');
        }
        if (tokenRequest && data?.error === 'invalid_client') throw new StoreError('invalid_client: CWS_CLIENT_ID / CWS_CLIENT_SECRET を確認してください');
        const detail = tokenRequest ? data?.error : [data?.error?.status, data?.error?.message].filter(Boolean).join(': ');
        // 書き込みの 5xx（ゲートウェイのタイムアウト等）は、サーバー側で成立している可能性が残る。
        if (!retry && response.status >= 500) throw new StoreError(`${operation}: ${unknownResult}。HTTP ${response.status} ${detail}`, 3);
        throw new StoreError(`${operation}: HTTP ${response.status} ${detail || 'エラー本文を取得できません'}`);
      }
      if (readError) throw new StoreError(`${operation}: ${retry ? '応答を JSON として読めません' : unknownResult}。${exceptionText(readError)}`, retry ? 1 : 3);
      return data;
    }
  }
  return {
    async authenticate() {
      const data = await request('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: credentials.CWS_CLIENT_ID, client_secret: credentials.CWS_CLIENT_SECRET, refresh_token: credentials.CWS_REFRESH_TOKEN, grant_type: 'refresh_token' }),
      }, { retry: true, timeout: 30000, operation: 'トークン更新', tokenRequest: true });
      if (!data?.access_token || typeof data.access_token !== 'string') throw new StoreError('アクセストークンを取得できません');
      token = data.access_token;
      secrets.CWS_ACCESS_TOKEN = token;
    },
    status() {
      return request(`${base}/v2/${resource}:fetchStatus`, { headers: { Authorization: `Bearer ${token}` } }, { retry: true, timeout: 30000, operation: '状況取得' });
    },
    upload(bytes) {
      return request(`${base}/upload/v2/${resource}:upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip' }, body: bytes }, { timeout: 180000, operation: 'アップロード' });
    },
    publish() {
      return request(`${base}/v2/${resource}:publish`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' }, { timeout: 60000, operation: '審査提出' });
    },
  };
}

export function statusSummary(status) {
  const revision = (value) => `${value.state ?? '不明'} / ${(value.distributionChannels ?? []).map((channel) => `版 ${channel.crxVersion ?? '不明'}・配信率 ${channel.deployPercentage ?? '不明'}%`).join(', ') || '版情報なし'}`;
  const lines = [`公開中: ${status.publishedItemRevisionStatus ? revision(status.publishedItemRevisionStatus) : 'なし'}`, `審査中の提出: ${status.submittedItemRevisionStatus ? revision(status.submittedItemRevisionStatus) : 'なし'}`];
  if (status.lastAsyncUploadState) lines.push(`直近の非同期アップロード: ${status.lastAsyncUploadState}`);
  if (status.takenDown) lines.push('警告: 公開停止中（takenDown）');
  if (status.warned) lines.push('警告: ストアからの警告あり（warned）');
  return lines.join('\n');
}

export async function main(args = process.argv.slice(2), {
  env = process.env, readFile = readFileSync, fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)), log = console.log, repoRoot = root,
} = {}) {
  const secrets = Object.fromEntries(keys.map((key) => [key, env[key]]));
  const output = (message) => log(redact(message, secrets));
  try {
    const options = parseArgs(args);
    if (options.help) {
      output('使い方:\n  node tools/release/storeApi.mjs status [--json] [--require-submittable] [--env-file=<path>] [--help]\n  node tools/release/storeApi.mjs submit [--zip=<path>] [--dry-run] [--env-file=<path>] [--help]\n--dry-run: 認証・状況・版を確認し、アップロードと審査提出は行いません');
      return 0;
    }
    const credentials = loadCredentials(env, resolve(options['env-file'] ?? resolve(repoRoot, '.env')), readFile, secrets);
    const zip = options.command === 'submit' ? selectZip(options.zip, readFile, repoRoot) : undefined;
    const client = createClient({ credentials, fetchImpl, sleep, secrets });
    await client.authenticate();
    const status = await client.status();
    const reason = submittableReason(status);
    if (options.command === 'status') {
      output(options.json ? JSON.stringify(status, (key, value) => key === 'publicKey' ? undefined : value, 2) : statusSummary(status));
      if (options['require-submittable'] && reason) { output(reason); return 1; }
      return 0;
    }
    if (reason) throw new StoreError(reason);
    const published = status.publishedItemRevisionStatus?.distributionChannels ?? [];
    if (published.some((channel) => compareVersions(zip.version, channel.crxVersion) <= 0)) throw new StoreError('提出する版が公開中の版以下のため提出できません');
    if (options['dry-run']) {
      output(`提出する版: ${zip.version}\nzip: ${zip.path}（${zip.bytes.length} バイト）\n公開中の版: ${published.map((channel) => channel.crxVersion).join(', ') || 'なし'}\nこの後の操作: アップロード → 審査提出（dry-run のため実行しません）`);
      return 0;
    }
    const uploaded = await client.upload(zip.bytes);
    if (uploaded?.uploadState === 'SUCCEEDED') {
      if (uploaded.crxVersion !== zip.version) throw new StoreError('アップロードした zip の版が提出する版と一致しません。審査提出を停止しました');
    } else if (uploaded?.uploadState === 'IN_PROGRESS') {
      let succeeded = false;
      for (let i = 0; i < 24; i++) {
        await sleep(5000);
        let current;
        try { current = await client.status(); }
        catch (error) { throw new StoreError(`${unknownResult}。${error.message}`, 3); }
        if (current.lastAsyncUploadState === 'FAILED') throw new StoreError('非同期アップロードに失敗しました');
        if (current.lastAsyncUploadState === 'SUCCEEDED') { succeeded = true; break; }
      }
      if (!succeeded) throw new StoreError(unknownResult, 3);
    } else throw new StoreError(`アップロードを完了できません: ${uploaded?.uploadState ?? '状態なし'}`);
    let publishedResult;
    try { publishedResult = await client.publish(); }
    catch (error) {
      if (error.code !== 3) output('zip のアップロードは完了済みで、審査提出だけが済んでいません');
      throw error;
    }
    output(`審査提出の状態: ${publishedResult?.state ?? '不明'}`);
    for (const warning of publishedResult?.warningInfo?.warnings ?? []) output(`警告: ${warning.reason ?? ''} ${warning.description ?? ''}`);
    try { output(statusSummary(await client.status())); }
    catch (error) { output(`警告: 提出後の状況取得ができませんでした。${error.message}`); }
    output('審査へ提出しました');
    return 0;
  } catch (error) {
    output(exceptionText(error));
    return error instanceof StoreError ? error.code : 1;
  }
}

// リンク経由のパスで起動されても直接実行と判定する（判定を外すと、何もせず終了コード 0 になる）。
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
