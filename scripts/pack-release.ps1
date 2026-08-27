# dist.zip 生成スクリプト（Chrome Web Store 提出用）
# dist/ をそのまま zip にすると source map（.map）が丸ごと入り、配布物サイズの
# 約4割を占める（Issue #126）。source map は DevTools を開いたときにしか読まれず、
# 元の TypeScript を丸ごと含むため、提出物からは除外する。
# 手元の dist/ 自体は変更しない（.map を残したまま開発時のデバッグ体験を保つ）ため、
# dist/ をステージングディレクトリへコピーしてから .map を取り除いて zip 化する。
#
# 重要: このファイルは UTF-8 **BOM 付き** で保存すること。BOM を落としてはいけない。
# `npm run build:release` は Windows PowerShell 5.1（powershell.exe）で起動されるが、
# 5.1 は BOM 無しの .ps1 を ACP（このマシンでは CP932）として読むため、UTF-8 の日本語が
# モジバケしてバイト境界がずれる。BOM を外すと全角括弧などが閉じ括弧を飲み込み、
# `Missing closing ')' in expression.` でパースエラーになりリリースが打てなくなる
# （scripts/bump-version.ps1 と同じ注意点）。

$ErrorActionPreference = "Stop"

# 以降の Remove-Item / Copy-Item / Compress-Archive はいずれも PowerShell の組み込み
# コマンドレットであり外部プロセスではないため $LASTEXITCODE を更新しない。
# エラー検出は上記の $ErrorActionPreference = "Stop" に委ね、失敗時は例外で即座に止める
# （$LASTEXITCODE チェックは git / npm など実際に外部プロセスを呼ぶ箇所でのみ意味を持つ。
# scripts/bump-version.ps1 参照）。

# ファイルパス（[System.IO.File] は PowerShell のカレントではなく .NET の
# カレントディレクトリを見るため、スクリプト位置から絶対パスで解決する）
$repoRoot = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $repoRoot "package.json"
$distPath = Join-Path $repoRoot "dist"
# 2段階の Join-Path で組み立てる（Split-Path でパスの一部を取り出す必要をなくす）。
# Join-Path はプラットフォームのセパレータで結合するため、この組み方なら
# Windows でも "/" と "\" が混在した文字列にならない。
$tmpRoot = Join-Path $repoRoot ".tmp"
$stagingPath = Join-Path $tmpRoot "release"
$zipPath = Join-Path $repoRoot "dist.zip"

# package.json から現在のバージョンを取得（メッセージ表示用）
$packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
$version = $packageJson.version

# 1. ステージングディレクトリを作り直す（既存があれば先に削除してから作成する）
if (Test-Path $stagingPath) {
    Remove-Item -Recurse -Force $stagingPath
}
# Compress-Archive -Path に配列（除外後のファイル一覧）を渡すとディレクトリ構造が失われ
# フラットな zip になり、sidepanel/sidepanel.js のような相対パス前提の拡張機能が壊れる。
# そのため「コピーしてから不要ファイルを消す」ステージング方式を取る。
# Copy-Item -Destination の結果は宛先の有無で変わる（無ければ dist/ の中身がそのまま
# $stagingPath 直下に入るが、既にあると $stagingPath\dist\ という1階層深いサブ
# ディレクトリになる）。この分岐に賭けず、宛先ディレクトリを明示的に作ってから
# 中身だけをコピーすることで、宛先の有無に関わらず結果を一定にする。
New-Item -ItemType Directory -Force -Path $stagingPath | Out-Null
Copy-Item -Recurse -Path (Join-Path $distPath "*") -Destination $stagingPath
Write-Host "✓ dist/ を $stagingPath へコピーしました"

# 2. ステージングディレクトリから .map ファイルを再帰的に削除する
# Get-ChildItem -Filter "*.map" は使わないこと。PowerShell の -Filter は Windows の
# 8.3 短縮名によるワイルドカードマッチの影響を受け、意図しない拡張子を巻き込みうる。
# dist/cmaps/ には pdf.js の .bcmap が168本入っており、これを誤って消すと
# 一部PDFの描画が壊れる。拡張子の厳密一致（-eq '.map'）で絞り込むこと。
# @() で必ず配列にする: 1件もマッチしないと Where-Object は $null を返し、
# $null | Remove-Item -Force はパイプラインに単一の $null を流すためパラメータ
# バインドに失敗し、「Cannot bind argument to parameter 'Path' because it is null.」
# という原因の分かりにくいエラーで止まる。
$mapFiles = @(Get-ChildItem -Path $stagingPath -Recurse -File | Where-Object { $_.Extension -eq '.map' })
if ($mapFiles.Count -eq 0) {
    # .map が1件も無いのは「本番ビルドが source map を生成していない」ことを意味し、
    # webpack.config.js の devtool 設定（'hidden-source-map'）が壊れている可能性がある。
    # 黙って空の zip 化に進まず、原因が分かるメッセージで止める。
    Write-Host "エラー: .map ファイルが1件も見つかりませんでした。" -ForegroundColor Red
    Write-Host "webpack.config.js の devtool 設定（'hidden-source-map'）が変わっていないか確認してください。" -ForegroundColor Red
    exit 1
}
$mapFiles | Remove-Item -Force
Write-Host "✓ .map ファイルを $($mapFiles.Count) 件削除しました"

# 3. ステージングディレクトリを dist.zip へ圧縮する
Compress-Archive -Path (Join-Path $stagingPath "*") -DestinationPath $zipPath -Force
Write-Host "Created dist.zip (v$version, Chrome Web Store submission)"

# 4. 後片付け（ステージングディレクトリを削除）
Remove-Item -Recurse -Force $stagingPath
