import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 判定一覧（.all-decisions）のメモ表示のレイアウト回帰テスト。
 *
 * renderAllDecisions() はメモ（他レビュアーのコメントを含む）を .decision-item の
 * 子要素として append する。.decision-item が flex 行のままだとメモが3つ目の flex
 * アイテムとして数十px幅まで潰れ、「相手のコメントが参照できない」状態になる
 * （実際に報告があった不具合）。CSS でしか担保できないため、ここでは decisions.css の
 * 該当ルールの存在を検査する。
 *
 * テストは .tmp/tests/ 配下にコンパイルされて実行されるため、__dirname ではなく
 * リポジトリルート（npm test の cwd）基準でCSSを解決する。
 */
function loadDecisionsCss(): string {
    return readFileSync(join(process.cwd(), 'src', 'sidepanel', 'styles', 'decisions.css'), 'utf8');
}

function loadFulltextConflictCss(): string {
    return readFileSync(join(process.cwd(), 'src', 'sidepanel', 'styles', 'fulltext-tab-conflict.css'), 'utf8');
}

/** セレクタ直後の宣言ブロック（`{ ... }`）を取り出す */
function ruleBodyOf(css: string, selector: string): string {
    const index = css.indexOf(selector);
    assert.notEqual(index, -1, `${selector} のルールが decisions.css に無い`);
    const open = css.indexOf('{', index);
    const close = css.indexOf('}', open);
    assert.ok(open !== -1 && close !== -1, `${selector} の宣言ブロックが壊れている`);
    return css.slice(open + 1, close);
}

test('.decision-item は折り返す（メモを同じ行に押し込まない）', () => {
    const body = ruleBodyOf(loadDecisionsCss(), '.decision-item {');
    assert.match(body, /flex-wrap:\s*wrap/);
});

test('.decision-item .note は行全体を占有する', () => {
    const body = ruleBodyOf(loadDecisionsCss(), '.decision-item .note {');
    // flex-basis 100%（= 前の要素と同じ行に並ばない）と、長い語・改行の扱いを担保する
    assert.match(body, /flex:\s*0\s+0\s+100%/);
    assert.match(body, /white-space:\s*pre-wrap/);
    assert.match(body, /overflow-wrap:\s*anywhere/);
});

test('フルテキストの不一致ビューのメモも改行を保持し、行から溢れない', () => {
    const body = ruleBodyOf(loadFulltextConflictCss(), '.fulltext-conflict-vote-note {');
    assert.match(body, /white-space:\s*pre-wrap/);
    assert.match(body, /overflow-wrap:\s*anywhere/);
});
