// シナリオのファイルの書き方。
//
// scenarios/<名前>.mjs は、defineScenario({...}) の戻り値を default export する（.mjs を1本足すだけで run.mjs が拾う）:
//
//   import { defineScenario } from '../lib/scenario.mjs';
//   import { POLL_STEP_TIMEOUT } from '../lib/constants.mjs';
//
//   export default defineScenario({
//       name: 'assignment-setup',                // --only に渡す名前。ファイル名（拡張子なし）と同じにする。スクリーンショットの接頭辞にもなる
//       title: 'ツアー assignment-setup',          // 結果の一覧に出す見出し
//       defaultRun: true,                        // 既定の実行（--only なし）に含めるか。省略時は true。false なら --only <名前> のときだけ動く
//       async run(run) { ... },                  // 本体。run は lib/run.mjs の Run（page・log・shot・fail・waitStep・click・clickNext・waitVisible・
//                                                // expectAbsent・waitCardGone・readProgress・waitTourStatus・openAndLogin・startFromBanner ほか）
//   });
//
// - run(run) は、新しい一時プロファイルでデモビルドの拡張機能を読み込んだブラウザの上で動く（lib/browser.mjs）。
//   失敗は run.fail(...)（待ちが切れた）か、普通の例外で表す。例外になれば、その時点のスクリーンショットが残る。
// - 配置・ダイアログ待ち・再開・ツアー一覧などの共通の確認は lib/checks.mjs にある。
// - 手順の確認は「run.waitStep(ツアーID, 手順ID)」で、カード（#guide-tour-card）が期待の手順になるのを待ってから操作する。
//   optional な手順（「押さずに次へ」）を飛ばすときは run.clickNext(手順ID) を使う（ボタンの data-guide-action は "next" のまま）。
// - 実データ・実アカウントは使わない。デモビルド（dist-demo/）のモックだけで動くこと。

const FIELDS = ['name', 'title', 'run'];

/** シナリオの定義を検査して返す。形が違えば、読み込みの時点で例外にする。 */
export function defineScenario(definition) {
    for (const field of FIELDS) {
        if (definition?.[field] === undefined) throw new Error(`シナリオの定義に ${field} がありません`);
    }
    if (typeof definition.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(definition.name)) {
        throw new Error(`シナリオの name は小文字・数字・ハイフンだけにしてください: ${definition.name}`);
    }
    if (typeof definition.run !== 'function') throw new Error(`シナリオ ${definition.name} の run が関数ではありません`);
    return { defaultRun: true, ...definition };
}
