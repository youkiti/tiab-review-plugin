// シェルを介さず CLI を呼び出し、応答を優先順位付きで分類する。
import { spawn } from 'node:child_process';

const KILL_GRACE_MS = 5000;

export function buildCliArgs(condition, schema) {
    return [
        '-p', '--model', condition.model, '--effort', condition.effort,
        '--system-prompt', '', '--tools', '', '--setting-sources', '',
        '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
        '--output-format', 'json', '--json-schema', JSON.stringify(schema),
    ];
}

// 認証情報の置き場所を指す変数だけは残す（消すとログイン済みの認証を見つけられなくなる）。
const KEPT_ENV = new Set(['CLAUDE_CONFIG_DIR']);

/**
 * 子プロセスに渡す環境変数を作る。ANTHROPIC_* と CLAUDE* を除く。
 * 親に API キーがあると、サブスクリプションではなく API 課金で走る。親が Claude Code のセッションだと、
 * その effort などの設定が判定に混ざる。除いた変数の名前だけを返す（値は記録しない）。
 */
export function buildChildEnv(env) {
    const childEnv = {};
    const removed = [];
    for (const [key, value] of Object.entries(env)) {
        const upper = key.toUpperCase();
        if (!KEPT_ENV.has(upper) && (upper.startsWith('ANTHROPIC_') || upper.startsWith('CLAUDE'))) {
            removed.push(key);
        } else {
            childEnv[key] = value;
        }
    }
    return { env: childEnv, removed: removed.sort() };
}

export function invokeClaude({ bin, args, prompt, timeoutMs, cwd, env }) {
    return new Promise((resolve) => {
        const raw = { exitCode: null, stdout: '', stderr: '', timedOut: false, spawnError: null };
        let child;
        let timer;
        let killTimer;
        let finished = false;
        const finish = () => {
            if (finished) {
                return;
            }
            finished = true;
            clearTimeout(timer);
            clearTimeout(killTimer);
            resolve(raw);
        };
        try {
            child = spawn(bin, args, { shell: false, cwd, windowsHide: true, env: env ?? buildChildEnv(process.env).env });
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', (data) => {
                raw.stdout += data;
            });
            child.stderr.on('data', (data) => {
                raw.stderr += data;
            });
            child.on('error', (error) => {
                raw.spawnError = error.message;
                finish();
            });
            child.on('close', (code) => {
                raw.exitCode = code;
                finish();
            });
            child.stdin.on('error', (error) => {
                raw.stderr += `\n標準入力の書き込み失敗: ${error.message}`;
            });
            timer = setTimeout(() => {
                raw.timedOut = true;
                child.kill();
                // kill しても close が来ない場合（孫プロセスがパイプを握る等）に、この1件だけを打ち切る。
                killTimer = setTimeout(finish, KILL_GRACE_MS);
            }, timeoutMs);
            child.stdin.end(prompt, 'utf8');
        } catch (error) {
            raw.spawnError = error.message;
            finish();
        }
    });
}

export function classifyCliResult(raw, requestedModel) {
    let parsed = null;
    const result = (kind, detail, output = null) => ({ kind, detail, parsed, output });
    if (raw.spawnError) {
        return result('spawn_error', String(raw.spawnError));
    }
    if (raw.timedOut) {
        return result('timeout', '制限時間を超過');
    }
    if (raw.exitCode !== 0) {
        return result('nonzero_exit', `終了コード: ${raw.exitCode}`);
    }
    try {
        parsed = JSON.parse(raw.stdout);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return result('bad_json', '単一の JSON オブジェクトではない');
        }
    } catch {
        return result('bad_json', '標準出力を JSON として解析できない');
    }
    if (parsed.is_error === true || parsed.subtype !== 'success') {
        return result('cli_error', `CLI が成功を報告していない: ${parsed.subtype ?? '未指定'}`);
    }
    if (!parsed.modelUsage || !Object.hasOwn(parsed.modelUsage, requestedModel)) {
        return result('model_mismatch', '要求モデルが modelUsage に存在しない');
    }
    const output = parsed.structured_output;
    if (!output || !Number.isFinite(output.include_probability)
        || output.include_probability < 0 || output.include_probability > 1
        || !Array.isArray(output.reasons) || !output.reasons.every((reason) => typeof reason === 'string')
        || !Array.isArray(output.evidence)) {
        return result('invalid_output', '構造化出力の確率・理由・根拠が不正');
    }
    return result('ok', '成功', {
        include_probability: output.include_probability,
        reasons: output.reasons,
        evidence: output.evidence,
    });
}
