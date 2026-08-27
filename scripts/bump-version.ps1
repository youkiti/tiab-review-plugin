# バージョン自動更新スクリプト
# このプロジェクトのバージョンは 0.<major>.<minor> 形式（先頭の 0 は固定）
#
# 使用方法: .\scripts\bump-version.ps1 [-BumpType major|minor]
#   major : 0.33.2 → 0.34.0（機能追加）
#   minor : 0.33.2 → 0.33.3（修正・小変更。デフォルト）
#   1.0.0 など先頭の数字を動かす場合は -SetVersion "1.0.0" で明示指定する
#
# 重要: このファイルは UTF-8 **BOM 付き** で保存すること。BOM を落としてはいけない。
# `npm run bump` は Windows PowerShell 5.1（powershell.exe）で起動されるが、5.1 は
# BOM 無しの .ps1 を ACP（このマシンでは CP932）として読むため、UTF-8 の日本語が
# モジバケしてバイト境界がずれる。BOM を外すと全角括弧などが閉じ括弧を飲み込み、
# `Missing closing ')' in expression.` でパースエラーになりリリースが打てなくなる。

param(
    [ValidateSet("major", "minor")]
    [string]$BumpType = "minor",

    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$SetVersion
)

$ErrorActionPreference = "Stop"

# ファイルパス（[System.IO.File] は PowerShell のカレントではなく .NET の
# カレントディレクトリを見るため、スクリプト位置から絶対パスで解決する）
$repoRoot = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $repoRoot "package.json"
$manifestJsonPath = Join-Path $repoRoot "src/manifest.json"
$sidepanelHtmlPath = Join-Path $repoRoot "src/sidepanel/sidepanel.html"

# 作業ツリーの汚れチェック（AutoResearchClaw サブモジュール内の生成物は
# 提出物に影響しないため --ignore-submodules=dirty で除外する）
$dirtyStatus = git -C $repoRoot status --porcelain --ignore-submodules=dirty
if ($LASTEXITCODE -ne 0) {
    Write-Host "エラー: git status の実行に失敗しました（終了コード: $LASTEXITCODE）" -ForegroundColor Red
    exit 1
}
if ($dirtyStatus) {
    Write-Host "エラー: 作業ツリーに未コミットの変更があります。バンプを中止します。" -ForegroundColor Red
    Write-Host ""
    Write-Host "汚れているファイル:"
    $dirtyStatus | ForEach-Object { Write-Host "  $_" }
    Write-Host ""
    Write-Host "対処方法:"
    Write-Host "  1. 変更を commit または stash してから再実行してください。"
    Write-Host "  2. 前回のバンプ失敗で書き換えが残っている場合は、次のコマンドで戻してください:"
    Write-Host "     git checkout -- package.json src/manifest.json src/sidepanel/sidepanel.html package-lock.json"
    exit 1
}

# package.json から現在のバージョンを取得
$packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
$currentVersion = $packageJson.version
Write-Host "現在のバージョン: $currentVersion"

# バージョンを分解（0.<major>.<minor>）
$versionParts = $currentVersion.Split(".")
$lead = [int]$versionParts[0]
$major = [int]$versionParts[1]
$minor = [int]$versionParts[2]

if ($SetVersion) {
    $newVersion = $SetVersion
    Write-Host "新しいバージョン: $newVersion (明示指定)"
}
else {
    # バージョンをインクリメント
    switch ($BumpType) {
        "major" {
            $major++
            $minor = 0
        }
        "minor" {
            $minor++
        }
    }

    $newVersion = "$lead.$major.$minor"
    Write-Host "新しいバージョン: $newVersion ($BumpType)"
}

# ビルド日時
$buildDate = Get-Date -Format "yyyy-MM-dd"

# 1. package.json / package-lock.json を更新
# npm version は package.json をカレントディレクトリから解決するため Push-Location で
# $repoRoot に切り替える（実測: インデント・キー順は変わらず version 値のみ置換される）。
Push-Location $repoRoot
try {
    npm version $newVersion --no-git-tag-version | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "エラー: npm version の実行に失敗しました（終了コード: $LASTEXITCODE）" -ForegroundColor Red
        exit 1
    }
}
finally {
    Pop-Location
}
Write-Host "✓ package.json / package-lock.json を更新しました"

# 2. manifest.json を更新（BOMなしUTF-8で保存）
$manifestContent = Get-Content $manifestJsonPath -Raw -Encoding UTF8
$manifestContent = $manifestContent -replace '"version": "[^"]*"', "`"version`": `"$newVersion`""
[System.IO.File]::WriteAllText($manifestJsonPath, $manifestContent, [System.Text.UTF8Encoding]::new($false))
Write-Host "✓ manifest.json を更新しました"

# 3. sidepanel.html のビルド日時を更新（BOMなしUTF-8で保存）
$sidepanelContent = Get-Content $sidepanelHtmlPath -Raw -Encoding UTF8
$sidepanelContent = $sidepanelContent -replace 'Build: [0-9-]+( [0-9:]+)?', "Build: $buildDate"
[System.IO.File]::WriteAllText($sidepanelHtmlPath, $sidepanelContent, [System.Text.UTF8Encoding]::new($false))
Write-Host "✓ sidepanel.html を更新しました (Build: $buildDate)"

# 4. バンプした4ファイルだけをローカル commit する（push はしない）
git -C $repoRoot add -- package.json src/manifest.json src/sidepanel/sidepanel.html package-lock.json
if ($LASTEXITCODE -ne 0) {
    Write-Host "エラー: git add の実行に失敗しました（終了コード: $LASTEXITCODE）" -ForegroundColor Red
    exit 1
}
git -C $repoRoot commit -m "chore: リリース v$newVersion へ version をバンプ"
if ($LASTEXITCODE -ne 0) {
    Write-Host "エラー: git commit の実行に失敗しました（終了コード: $LASTEXITCODE）" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=== バージョン更新完了: $currentVersion → $newVersion ==="
Write-Host "変更は未 push のローカル commit です。この後の 'npm run build:release' が失敗した場合は"
Write-Host "'git reset --hard HEAD~1' で戻せます（差分は version と Build 日付のみ）。"
