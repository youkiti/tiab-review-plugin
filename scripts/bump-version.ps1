# バージョン自動更新スクリプト
# このプロジェクトのバージョンは 0.<major>.<minor> 形式（先頭の 0 は固定）
#
# 使用方法: .\scripts\bump-version.ps1 [-BumpType major|minor]
#   major : 0.33.2 → 0.34.0（機能追加）
#   minor : 0.33.2 → 0.33.3（修正・小変更。デフォルト）
#   1.0.0 など先頭の数字を動かす場合は -SetVersion "1.0.0" で明示指定する

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

# 1. package.json を更新（正規表現で version を置換、BOMなしUTF-8で保存）
$packageContent = Get-Content $packageJsonPath -Raw -Encoding UTF8
$packageContent = $packageContent -replace '"version":\s*"[^"]*"', "`"version`": `"$newVersion`""
[System.IO.File]::WriteAllText($packageJsonPath, $packageContent, [System.Text.UTF8Encoding]::new($false))
Write-Host "✓ package.json を更新しました"

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

Write-Host ""
Write-Host "=== バージョン更新完了: $currentVersion → $newVersion ==="
