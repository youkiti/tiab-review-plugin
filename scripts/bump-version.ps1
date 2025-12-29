# バージョン自動更新スクリプト
# 使用方法: .\scripts\bump-version.ps1 [major|minor|patch]
# デフォルト: patch

param(
    [ValidateSet("major", "minor", "patch")]
    [string]$BumpType = "patch"
)

$ErrorActionPreference = "Stop"

# ファイルパス
$packageJsonPath = "package.json"
$manifestJsonPath = "src/manifest.json"
$sidepanelHtmlPath = "src/sidepanel/sidepanel.html"

# package.json から現在のバージョンを取得
$packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
$currentVersion = $packageJson.version
Write-Host "現在のバージョン: $currentVersion"

# バージョンを分解
$versionParts = $currentVersion.Split(".")
$major = [int]$versionParts[0]
$minor = [int]$versionParts[1]
$patch = [int]$versionParts[2]

# バージョンをインクリメント
switch ($BumpType) {
    "major" {
        $major++
        $minor = 0
        $patch = 0
    }
    "minor" {
        $minor++
        $patch = 0
    }
    "patch" {
        $patch++
    }
}

$newVersion = "$major.$minor.$patch"
Write-Host "新しいバージョン: $newVersion ($BumpType)"

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
