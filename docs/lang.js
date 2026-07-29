/**
 * ドキュメントサイトの表示言語を切り替えるスクリプト。
 *
 * - <head> 内から `<script src="lang.js"></script>`（defer なし）で同期読み込みする。
 *   body が描画される前に document.documentElement へ lang / data-lang を
 *   付与することで、日英併記が一瞬見えてから片方が消える FOUC を防ぐ。
 * - JavaScript が無効な環境では data-lang 属性が付かないため、CSS 側の
 *   非表示ルール（html[data-lang="..."] ...）が一切発火せず、従来どおり
 *   日本語・英語の両方が表示される（壊れない）。
 */
(function () {
    "use strict";

    var STORAGE_KEY = "tiab-docs-lang";
    var DEFAULT_LANG = "en";

    /**
     * ブラウザの言語設定から ja / en を推定する。
     * navigator.languages（優先順のリスト）を優先し、無ければ navigator.language を見る。
     * 判定できない場合は既定値（英語）を返す。
     */
    function detectBrowserLang() {
        var candidates = [];
        if (window.navigator) {
            if (Array.isArray(navigator.languages) && navigator.languages.length) {
                candidates = navigator.languages;
            } else if (navigator.language) {
                candidates = [navigator.language];
            }
        }
        for (var i = 0; i < candidates.length; i++) {
            var tag = candidates[i];
            if (typeof tag === "string" && tag.toLowerCase().indexOf("ja") === 0) {
                return "ja";
            }
        }
        return DEFAULT_LANG;
    }

    /** URL クエリ ?lang=ja|en を読む。想定外の値は null を返してフォールバックさせる。 */
    function getQueryLang() {
        try {
            var params = new URLSearchParams(window.location.search);
            var value = params.get("lang");
            if (value === "ja" || value === "en") {
                return value;
            }
        } catch (e) {
            // URLSearchParams が使えない古い環境などは無視してフォールバック
        }
        return null;
    }

    /** localStorage に保存された選択を読む。プライベートモード等で例外が出る場合は null。 */
    function getStoredLang() {
        try {
            var value = window.localStorage.getItem(STORAGE_KEY);
            if (value === "ja" || value === "en") {
                return value;
            }
        } catch (e) {
            // localStorage が使用不可の場合は無視してフォールバック
        }
        return null;
    }

    /** localStorage への保存を試みる。失敗しても無視する（機能上は問題ない）。 */
    function storeLang(lang) {
        try {
            window.localStorage.setItem(STORAGE_KEY, lang);
        } catch (e) {
            // 保存できなくても表示自体は継続できるので握りつぶす
        }
    }

    // 優先順位: URLクエリ > localStorage > ブラウザ言語 > 既定(英語)
    var queryLang = getQueryLang();
    var lang = queryLang || getStoredLang() || detectBrowserLang();

    // URLクエリで明示指定された場合は、他ページに遷移しても選択が保持されるよう保存する
    if (queryLang) {
        storeLang(queryLang);
    }

    // body 描画前に確定させることで FOUC（一瞬両方見えてから消える）を防ぐ
    document.documentElement.lang = lang;
    document.documentElement.setAttribute("data-lang", lang);

    /** <title> と <meta name="description"> を、head 側に埋め込んだ data-ja/data-en に差し替える。 */
    function applyHeadText(currentLang) {
        var titleEl = document.querySelector("title");
        if (titleEl) {
            var titleText = titleEl.getAttribute(currentLang === "ja" ? "data-ja" : "data-en");
            if (titleText) {
                document.title = titleText;
            }
        }

        var descEl = document.querySelector('meta[name="description"]');
        if (descEl) {
            var descText = descEl.getAttribute(currentLang === "ja" ? "data-ja" : "data-en");
            if (descText) {
                descEl.setAttribute("content", descText);
            }
        }
    }

    /** ヘッダー（ロゴの右）に言語切替トグルボタンを生成して配線する。 */
    function createLangToggle(getLang, setLang) {
        var host = document.querySelector(".header .container");
        if (!host || host.querySelector(".lang-toggle")) {
            return;
        }

        var button = document.createElement("button");
        button.type = "button";
        button.className = "lang-toggle";

        function render() {
            var current = getLang();
            // ボタンのラベルには「切り替え先」の言語名を表示する
            button.textContent = current === "ja" ? "English" : "日本語";
            button.setAttribute(
                "aria-label",
                current === "ja" ? "Switch to English" : "日本語表示に切り替え"
            );
        }

        button.addEventListener("click", function () {
            var next = getLang() === "ja" ? "en" : "ja";
            setLang(next);
            render();
        });

        render();
        host.appendChild(button);
    }

    document.addEventListener("DOMContentLoaded", function () {
        applyHeadText(lang);

        createLangToggle(
            function () {
                return lang;
            },
            function (next) {
                lang = next;
                storeLang(lang);
                document.documentElement.lang = lang;
                document.documentElement.setAttribute("data-lang", lang);
                applyHeadText(lang);
            }
        );
    });
})();
