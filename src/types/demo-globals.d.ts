// webpack DefinePlugin が注入するデモビルド判定フラグ。
// 通常ビルド（dev/production）では false、`--env demo` ビルドでは true になる。
// 現時点では共有コードから参照していないが、将来デモ限定の分岐が必要になった際に
// 使えるようグローバル型だけ用意しておく。
declare const __DEMO__: boolean;

// webpack DefinePlugin が注入するビルド先の判定。デモを含め、Web版だけ true になる。
declare const __WEB_BUILD__: boolean;
