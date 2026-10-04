// 実ネットワーク・実ファイルを使わず、提出の停止条件と再実行の制限を検査する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { main, compareVersions, redact, submittableReason, readZipVersion, StoreError } from './storeApi.mjs';

function makeZip(entries, method = 0, descriptor = false) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const filename = Buffer.from(name);
    const data = Buffer.from(content);
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(descriptor ? 8 : 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(descriptor ? 0 : compressed.length, 18);
    local.writeUInt32LE(descriptor ? 0 : data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const trailer = Buffer.alloc(descriptor ? 16 : 0);
    if (descriptor) {
      trailer.writeUInt32LE(0x08074b50);
      trailer.writeUInt32LE(compressed.length, 8);
      trailer.writeUInt32LE(data.length, 12);
    }
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(descriptor ? 8 : 0, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, filename, compressed, trailer);
    central.push(entry, filename);
    offset += local.length + filename.length + compressed.length + trailer.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const env = { CWS_CLIENT_ID: 'client-secret-id', CWS_CLIENT_SECRET: 'client-secret-value', CWS_REFRESH_TOKEN: 'refresh-secret-value', CWS_PUBLISHER_ID: 'publisher-secret-id' };
const accessToken = 'access-secret-value';
const zipBytes = makeZip([['manifest.json', '{"version":"0.12.0"}']]);
const published = { publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '0.9.0', deployPercentage: 100 }] } };
const ok = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const token = () => ok({ access_token: accessToken });
const upload = () => ok({ uploadState: 'SUCCEEDED', crxVersion: '0.12.0' });
const publish = () => ok({ state: 'PENDING_REVIEW' });

const envText = (values) => Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n');

test('共有ファイルは第一のファイルのディレクトリ基準で読み、キーごとに優先する', async () => {
  const first = resolve('settings/alternate.env');
  const shared = resolve('settings/shared/.env');
  const sharedValues = Object.fromEntries(Object.keys(env).map((key) => [key, `shared-${key}`]));
  for (const current of [{}, { CWS_CLIENT_ID: 'environment-client' }]) {
    for (const firstValues of [{}, { CWS_CLIENT_ID: 'first-client' }]) {
      const paths = [];
      const result = await run(['status', '--env-file=settings/alternate.env'], [token(), ok(published)], {
        env: current, readFile: (path) => {
          paths.push(path);
          if (path === first) return envText({ CWS_ENV_FILE: 'shared/.env', ...firstValues });
          if (path === shared) return envText(sharedValues);
          throw new Error('想定外の読み取り');
        },
      });
      assert.equal(result.code, 0);
      assert.deepEqual(paths, [first, shared]);
      assert.equal(result.calls[0].body.get('client_id'), current.CWS_CLIENT_ID ?? firstValues.CWS_CLIENT_ID ?? sharedValues.CWS_CLIENT_ID);
    }
  }
});

test('共有パスは環境変数を優先し、未設定・空文字なら追加の読み取りをしない', async () => {
  for (const sharedPath of [undefined, '', 'shared/.env', resolve('absolute-shared.env')]) {
    const paths = [];
    const result = await run(['status'], [token(), ok(published)], {
      env: { ...env, ...(sharedPath === undefined ? {} : { CWS_ENV_FILE: sharedPath }) },
      readFile: (path) => {
        paths.push(path);
        if (path === envPath) return sharedPath === undefined ? '' : 'CWS_ENV_FILE=ignored.env';
        if (sharedPath && path === resolve(repoRoot, sharedPath)) return '';
        throw new Error('想定外の読み取り');
      },
    });
    assert.equal(result.code, 0);
    assert.deepEqual(paths, sharedPath ? [envPath, resolve(repoRoot, sharedPath)] : [envPath]);
  }
});

test('共有ファイルの ENOENT・EACCES は設定エラーで通信しない', async () => {
  for (const code of ['ENOENT', 'EACCES']) {
    const result = await run(['status'], [], { readFile: (path) => {
      if (path === envPath) return 'CWS_ENV_FILE=shared/.env';
      assert.equal(path, resolve(repoRoot, 'shared/.env'));
      throw Object.assign(new Error('読み取り不可'), { code });
    } });
    assert.equal(result.code, 2);
    assert.equal(result.text, 'CWS_ENV_FILE が指す環境設定ファイルを読めません');
    assert.equal(result.calls.length, 0);
  }
});

test('共有値と第一のファイルの値は未使用でも伏せ、空文字はフォールバックしない', async () => {
  const sharedValues = Object.fromEntries(Object.keys(env).map((key) => [key, `shared-${key}`]));
  const firstValues = Object.fromEntries(Object.keys(env).map((key) => [key, `first-${key}`]));
  const readFile = (path, values = firstValues) => {
    if (path === envPath) return envText({ ...values, CWS_ENV_FILE: 'shared/.env' });
    if (path === resolve(repoRoot, 'shared/.env')) return envText(sharedValues);
    throw new Error('想定外の読み取り');
  };
  const values = [...Object.values(sharedValues), ...Object.values(firstValues)];
  const result = await run(['status'], [ok({ error: values.join(' ') }, 400)], { readFile });
  assert.equal(result.code, 1);
  for (const value of values) assert.ok(!result.text.includes(value));
  for (const key of Object.keys(env)) {
    for (const fromEnv of [true, false]) {
      const empty = await run(['status'], [], {
        env: fromEnv ? { ...env, [key]: '' } : {},
        readFile: (path) => readFile(path, { ...firstValues, [key]: '' }),
      });
      assert.equal(empty.code, 2);
      assert.equal(empty.text, `不足している設定: ${key}`);
      assert.equal(empty.calls.length, 0);
    }
  }
});

const repoRoot = resolve('fake-repository');
const envPath = resolve(repoRoot, '.env');
const packagePath = resolve(repoRoot, 'package.json');
const zipPath = resolve(repoRoot, 'dist.zip');
function fileReader(bytes = zipBytes) {
  return (path) => {
    if (path === envPath) return '';
    if (path === packagePath) return '{"version":"0.12.0"}';
    if (path === zipPath || path === resolve('other.zip')) return bytes;
    throw new Error('想定外の読み取り');
  };
}

async function run(args, responses = [], overrides = {}) {
  const calls = [], logs = [], waits = [], reads = [];
  const code = await main(args, {
    env, repoRoot,
    readFile: (path) => {
      reads.push(path);
      return fileReader()(path);
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init });
      assert.ok(init.signal instanceof AbortSignal);
      const response = responses.shift();
      assert.ok(response, '想定外の通信');
      if (response instanceof Error) throw response;
      return response;
    },
    sleep: async (ms) => waits.push(ms), log: (text) => logs.push(text), ...overrides,
  });
  return { code, calls, logs, waits, reads, text: logs.join('\n') };
}

test('無圧縮・deflate・データ記述子つき zip から版を読む', () => {
  for (const method of [0, 8]) {
    for (const descriptor of [false, true]) {
      assert.equal(readZipVersion(makeZip([['manifest.json', '{"version":"0.12.0"}']], method, descriptor)), '0.12.0');
    }
  }
});

test('先行エントリと BOM を許容し、ルートの manifest.json だけを読む', () => {
  assert.equal(readZipVersion(makeZip([['sub/manifest.json', '{"version":"0.11.0"}'], ['manifest.json', '\uFEFF{"version":"0.12.0"}']])), '0.12.0');
  assert.throws(() => readZipVersion(makeZip([['sub/manifest.json', '{"version":"0.12.0"}']])), (error) => error instanceof StoreError && error.code === 2);
});

test('壊れた zip・JSON・版の欠落は終了コード 2 で通信しない', async () => {
  const brokenCentral = Buffer.from(zipBytes);
  brokenCentral.writeUInt32LE(0, brokenCentral.readUInt32LE(brokenCentral.length - 6));
  const brokenLocal = Buffer.from(zipBytes);
  brokenLocal.writeUInt32LE(0);
  const outOfRange = Buffer.from(zipBytes);
  outOfRange.writeUInt32LE(0xffffffff, outOfRange.readUInt32LE(outOfRange.length - 6) + 20);
  for (const bytes of [Buffer.from('zip ではありません'), zipBytes.subarray(0, 12), brokenCentral, brokenLocal, outOfRange,
    makeZip([['manifest.json', 'JSON ではありません']]), makeZip([['manifest.json', '{}']]),
    makeZip([['manifest.json', '{"version":12}']]), makeZip([['sub/manifest.json', '{}']]),
    makeZip([['manifest.json', '{"version":"0.12.0"}']], 99)]) {
    const result = await run(['submit', '--zip=other.zip'], [], { readFile: fileReader(bytes) });
    assert.equal(result.code, 2);
    assert.equal(result.text, 'zip 内の manifest.json から版を読み取れません');
    assert.equal(result.calls.length, 0);
  }
});

for (const dryRun of [false, true]) {
  test(`版が食い違う zip は submit${dryRun ? ' --dry-run' : ''} で認証前に止まる`, async () => {
    for (const version of ['0.11.0', '0.12.0.0']) {
      const bytes = makeZip([['manifest.json', JSON.stringify({ version })]]);
      const result = await run(['submit', '--zip=other.zip', ...(dryRun ? ['--dry-run'] : [])],
        [token(), ok(published), upload(), publish(), ok(published)], { readFile: fileReader(bytes) });
      assert.equal(result.calls.length, 0);
      assert.equal(result.code, 2);
      assert.equal(result.text, 'zip 内の manifest.json の版と package.json の版が一致しません');
    }
  });
}

test('版が食い違う zip は IN_PROGRESS の応答列でも upload・publish へ進まない', async () => {
  const bytes = makeZip([['manifest.json', '{"version":"0.11.0"}']]);
  const result = await run(['submit', '--zip=other.zip'],
    [token(), ok(published), ok({ uploadState: 'IN_PROGRESS' }), ok({ lastAsyncUploadState: 'SUCCEEDED' }), publish(), ok(published)],
    { readFile: fileReader(bytes) });
  assert.deepEqual(result.calls.map((call) => call.url.split('/').pop().split(':').pop()), []);
  assert.equal(result.code, 2);
  assert.equal(result.text, 'zip 内の manifest.json の版と package.json の版が一致しません');
});

test('不足キーのみを示し、設定値を漏らさない', async () => {
  for (const key of Object.keys(env)) {
    const result = await run(['status'], [], { env: { ...env, [key]: '' } });
    assert.equal(result.code, 2);
    assert.equal(result.text, `不足している設定: ${key}`);
    assert.equal(result.calls.length, 0);
  }
  const result = await run(['status'], [], { env: {} });
  assert.equal(result.text, `不足している設定: ${Object.keys(env).join(', ')}`);
});

test('環境変数優先・別ファイル指定・環境変数を変更しない', async () => {
  const current = { CWS_CLIENT_ID: env.CWS_CLIENT_ID };
  const original = { ...current };
  const paths = [];
  const result = await run(['status', '--env-file=alternate.env'], [token(), ok(published)], {
    env: current, readFile: (path) => { paths.push(path); return Object.entries({ ...env, CWS_CLIENT_ID: 'file-client-id' }).map(([key, value]) => `${key}=${value}`).join('\n'); },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(current, original);
  assert.equal(paths[0], resolve('alternate.env'));
  assert.equal(result.calls[0].body.get('client_id'), env.CWS_CLIENT_ID);
  assert.equal(result.calls[0].body.get('grant_type'), 'refresh_token');
});

test('環境設定ファイルの欠落は許容し、読み取り失敗は設定エラー', async () => {
  for (const [errorCode, expected] of [['ENOENT', 0], ['EACCES', 2]]) {
    const result = await run(['status'], [token(), ok(published)], { readFile: () => { throw Object.assign(new Error('読み取り不可'), { code: errorCode }); } });
    assert.equal(result.code, expected);
  }
});

test('エラー本文・例外・cause・警告・JSON の秘密値と URL を伏せる', async () => {
  const secretText = [...Object.values(env), accessToken, `https://chromewebstore.googleapis.com/v2/publishers/${env.CWS_PUBLISHER_ID}/items/example:publish`].join(' ');
  const results = [
    await run(['submit'], [token(), ok(published), ok({ error: { status: secretText, message: secretText } }, 400)]),
    await run(['submit'], [token(), ok(published), new Error(secretText, { cause: new Error(secretText) })]),
    await run(['submit'], [token(), ok(published), upload(), ok({ state: secretText, warningInfo: { warnings: [{ reason: secretText, description: secretText }] } }), ok(published)]),
    await run(['status', '--json'], [token(), ok({ ...published, name: `publishers/${env.CWS_PUBLISHER_ID}/items/example`, publicKey: '非表示の公開鍵' })]),
  ];
  for (const result of results) {
    for (const value of [...Object.values(env), accessToken, 'https://chromewebstore.googleapis.com', '非表示の公開鍵']) assert.ok(!result.text.includes(value), value);
  }
  assert.equal(JSON.parse(results[3].text).name, 'publishers/<CWS_PUBLISHER_ID>/items/example');
  assert.equal(JSON.parse(results[3].text).publicKey, undefined);
  assert.equal(redact('a"b a%22b a\\"b', { CWS_CLIENT_SECRET: 'a"b' }), '<CWS_CLIENT_SECRET> <CWS_CLIENT_SECRET> <CWS_CLIENT_SECRET>');
});

test('トークン更新は 5xx・429・通信例外を再試行し最大 3 回で止まる', async () => {
  const result = await run(['status'], [ok({}, 503), ok({}, 429), token(), ok(published)]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.waits, [1000, 3000]);
  const failed = await run(['status'], [new Error('切断'), new Error('切断'), new Error('切断')]);
  assert.equal(failed.code, 1);
  assert.equal(failed.calls.length, 3);
});

test('認証の invalid_grant / invalid_client は再試行せず案内する', async () => {
  for (const error of ['invalid_grant', 'invalid_client', '別のエラー']) {
    const result = await run(['status'], [ok({ error }, 400)]);
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 1);
    assert.match(result.text, new RegExp(error));
    if (error === 'invalid_grant') {
      for (const message of ['7 日', 'https://developers.google.com/oauthplayground', 'https://www.googleapis.com/auth/chromewebstore', 'CWS_REFRESH_TOKEN', 'tools/release/README.md']) assert.ok(result.text.includes(message));
    }
    if (error === 'invalid_client') assert.match(result.text, /CWS_CLIENT_ID \/ CWS_CLIENT_SECRET/);
    if (error === '別のエラー') assert.match(result.text, /HTTP 400/);
  }
});

test('fetchStatus の JSON 破損は再試行し、4xx は再試行しない', async () => {
  const malformed = { status: 200, ok: true, json: async () => { throw new SyntaxError('JSON 不正'); } };
  const result = await run(['status'], [token(), malformed, ok(published)]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.waits, [1000]);
  for (const status of [400, 401, 403, 404]) {
    const failed = await run(['status'], [token(), ok({ error: { message: '取得不可', status: 'NOT_FOUND' } }, status)]);
    assert.equal(failed.code, 1);
    assert.equal(failed.calls.length, 2);
    assert.match(failed.text, new RegExp(`HTTP ${status}`));
  }
  const failed = await run(['status'], [token(), malformed, malformed, malformed]);
  assert.equal(failed.code, 1);
  assert.equal(failed.calls.length, 4);
});

test('提出可否の判定を status と submit で共有する', async () => {
  for (const [state, expected] of [[undefined, 0], ['PENDING_REVIEW', 1], ['STAGED', 1], ['REJECTED', 0], ['CANCELLED', 0], ['PUBLISHED', 0]]) {
    const status = { ...published, ...(state ? { submittedItemRevisionStatus: { state } } : {}) };
    assert.equal(Boolean(submittableReason(status)), Boolean(expected));
    for (const args of [['status', '--require-submittable'], ['submit', '--dry-run']]) {
      assert.equal((await run(args, [token(), ok(status)])).code, expected);
    }
  }
  for (const args of [['status', '--require-submittable'], ['submit', '--dry-run']]) {
    const result = await run(args, [token(), ok({ ...published, takenDown: true, warned: true })]);
    assert.equal(result.code, 1);
    assert.match(result.text, /takenDown/);
  }
});

test('状態の要約は全チャネルと省略可能な状態を扱う', async () => {
  const result = await run(['status'], [token(), ok({ publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '0.9.0', deployPercentage: 80 }, { crxVersion: '0.8.0', deployPercentage: 20 }] }, submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '0.12.0' }] }, lastAsyncUploadState: 'SUCCEEDED', warned: true })]);
  for (const expected of ['0.9.0', '0.8.0', '80%', '20%', '0.12.0', 'PENDING_REVIEW', 'SUCCEEDED', 'warned']) assert.ok(result.text.includes(expected));
  assert.equal(result.calls.length, 2);
  assert.ok(result.calls.every((call) => !/:upload|:publish/.test(call.url)));
});

test('版を数値比較し、全公開チャネルの同じ版・古い版を拒否する', async () => {
  assert.equal(compareVersions('0.12.0', '0.9.0'), 1);
  assert.equal(compareVersions('0.12.0', '0.12.0.0'), 0);
  for (const version of ['0.12.0', '0.13.0']) {
    const result = await run(['submit', '--dry-run'], [token(), ok({ publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: '0.9.0' }, { crxVersion: version }] } })]);
    assert.equal(result.code, 1);
    assert.match(result.text, /以下/);
  }
});

test('zip の欠落・空ファイルを検査し、既定は dist.zip、指定名は任意', async () => {
  for (const missingPath of [packagePath, resolve('other.zip')]) {
    const result = await run(['submit', '--zip=other.zip'], [], { readFile: (path) => {
      if (path === missingPath) throw new Error('存在しません');
      return fileReader()(path);
    } });
    assert.equal(result.code, 2);
    assert.equal(result.text, 'zip または package.json を読み取れません');
    assert.equal(result.calls.length, 0);
  }
  const empty = await run(['submit'], [], { readFile: fileReader(Buffer.alloc(0)) });
  assert.equal(empty.code, 2);
  assert.equal(empty.text, 'zip が空です');
  assert.equal(empty.calls.length, 0);
  for (const args of [[], ['--zip=other.zip']]) {
    const result = await run(['submit', '--dry-run', ...args], [token(), ok(published)]);
    assert.equal(result.code, 0);
    assert.ok(result.reads.includes(args.length ? resolve('other.zip') : zipPath));
    assert.ok(result.text.includes(`${zipBytes.length} バイト`));
    assert.match(result.text, /アップロード → 審査提出/);
    assert.equal(result.calls.length, 2);
    assert.ok(result.calls.every((call) => !/:upload|:publish/.test(call.url)));
  }
});

test('正常系は upload → publish → fetchStatus を各 1 回送り、zip バイトを POST する', async () => {
  const result = await run(['submit'], [token(), ok(published), upload(), publish(), ok(published)]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls.map((call) => call.url.split('/').pop().split(':').pop()), ['token', 'fetchStatus', 'upload', 'publish', 'fetchStatus']);
  const sent = result.calls[2];
  assert.equal(sent.method, 'POST');
  assert.equal(sent.headers['Content-Type'], 'application/zip');
  assert.equal(sent.headers.Authorization, `Bearer ${accessToken}`);
  assert.equal(sent.body, zipBytes);
  assert.equal(result.calls[3].method, 'POST');
  assert.equal(result.calls[3].body, '{}');
  assert.equal(result.calls[3].headers['Content-Type'], 'application/json');
  assert.match(result.text, /審査へ提出しました/);
});

test('upload の版不一致・失敗・未知の状態・HTTP エラーでは publish しない', async () => {
  for (const response of [ok({ uploadState: 'SUCCEEDED', crxVersion: '0.11.0' }), ...['FAILED', 'NOT_FOUND', 'UPLOAD_STATE_UNSPECIFIED', 'UNKNOWN'].map((uploadState) => ok({ uploadState })), ok({ error: { status: 'INVALID_ARGUMENT', message: 'エラー' } }, 400)]) {
    const result = await run(['submit'], [token(), ok(published), response]);
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 3);
  }
});

test('upload の 5xx は再実行せず結果不明となり publish しない', async () => {
  const result = await run(['submit'], [token(), ok(published), ok({ error: { status: 'UNAVAILABLE', message: 'エラー' } }, 504)]);
  assert.equal(result.code, 3);
  assert.equal(result.calls.length, 3);
  assert.match(result.text, /結果不明.*HTTP 504/);
});

test('非同期 upload の成功・失敗・時間切れ・状態取得失敗を扱う', async () => {
  for (const state of ['SUCCEEDED', 'FAILED', 'IN_PROGRESS', '取得失敗']) {
    const after = state === 'IN_PROGRESS' ? Array.from({ length: 24 }, () => ok({ lastAsyncUploadState: state })) : state === '取得失敗' ? [ok({}, 404)] : [ok({ lastAsyncUploadState: state })];
    const result = await run(['submit'], [token(), ok(published), ok({ uploadState: 'IN_PROGRESS' }), ...after, ...(state === 'SUCCEEDED' ? [publish(), ok(published)] : [])]);
    assert.equal(result.code, state === 'SUCCEEDED' ? 0 : state === 'FAILED' ? 1 : 3);
    assert.equal(result.calls.filter((call) => call.url.endsWith(':publish')).length, state === 'SUCCEEDED' ? 1 : 0);
    assert.deepEqual(result.waits, Array(state === 'IN_PROGRESS' ? 24 : 1).fill(5000));
  }
});

test('upload タイムアウトは再実行せず結果不明となり publish しない', async () => {
  const result = await run(['submit'], [token(), ok(published), new Error('タイムアウト')]);
  assert.equal(result.code, 3);
  assert.equal(result.calls.length, 3);
  assert.match(result.text, /結果不明.*npm run store:status.*自動では再実行しない/);
});

test('publish の 4xx・5xx・通信例外は再実行せず、失敗と結果不明を区別する', async () => {
  for (const [response, code] of [[ok({ error: { status: 'FAILED_PRECONDITION', message: '提出不可' } }, 400), 1], [ok({ error: { status: 'INTERNAL', message: '不明' } }, 503), 3], [new Error('切断'), 3]]) {
    const result = await run(['submit'], [token(), ok(published), upload(), response]);
    assert.equal(result.code, code);
    assert.equal(result.calls.length, 4);
    if (code === 1) assert.match(result.text, /アップロードは完了済みで、審査提出だけが済んでいません/);
    else {
      assert.match(result.text, /結果不明/);
      assert.doesNotMatch(result.text, /審査提出だけが済んでいません|審査へ提出しました/);
    }
  }
});

test('書き込み応答を読めない場合も結果不明とする', async () => {
  const broken = { status: 200, ok: true, json: async () => { throw new Error('切断'); } };
  for (const responses of [[token(), ok(published), broken], [token(), ok(published), upload(), broken]]) {
    const result = await run(['submit'], responses);
    assert.equal(result.code, 3);
    assert.match(result.text, /結果不明/);
  }
});

test('提出後の状態取得の失敗は警告のみで成功を維持する', async () => {
  const result = await run(['submit'], [token(), ok(published), upload(), publish(), ok({}, 404)]);
  assert.equal(result.code, 0);
  assert.match(result.text, /警告: 提出後/);
  assert.equal(result.logs.at(-1), '審査へ提出しました');
});

test('ヘルプと不正引数はファイルも通信も使わない', async () => {
  for (const args of [['--help'], ['status', '--help'], ['submit', '--help'], [], ['unknown'], ['status', '--dry-run'], ['submit', '--json'], ['submit', '--zip='], ['status', '--env-file='], ['status', '--unknown']]) {
    const result = await run(args);
    assert.equal(result.code, args.includes('--help') ? 0 : 2);
    assert.equal(result.reads.length, 0);
    assert.equal(result.calls.length, 0);
    if (result.code === 0) assert.match(result.text, /使い方/);
  }
});
