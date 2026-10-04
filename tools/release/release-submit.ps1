# このファイルは UTF-8 BOM 付きで保存すること。
# Windows PowerShell 5.1 は BOM 無しを CP932 として読み、日本語が文字化けしてパースエラーになる。
param([ValidateSet("major", "minor")][string]$BumpType = "minor")

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $repoRoot

function Stop-Release([string]$Message) {
    Write-Host $Message -ForegroundColor Red
    exit 1
}

# 前提の確認がすべて済むまで、版と成果物は変更しない。
$branch = git branch --show-current
if ($LASTEXITCODE -ne 0) { Stop-Release "現在のブランチを確認できません" }
if ($branch -ne "main") { Stop-Release "main ブランチで実行してください" }
$dirtyStatus = git status --porcelain --ignore-submodules=dirty
if ($LASTEXITCODE -ne 0) { Stop-Release "作業ツリーを確認できません" }
if ($dirtyStatus) { Stop-Release "作業ツリーに未コミットの変更があります" }
git fetch origin main --quiet
if ($LASTEXITCODE -ne 0) { Stop-Release "origin/main の取得に失敗しました" }
$headSha = git rev-parse HEAD
if ($LASTEXITCODE -ne 0) { Stop-Release "HEAD を確認できません" }
$originSha = git rev-parse origin/main
if ($LASTEXITCODE -ne 0) { Stop-Release "origin/main を確認できません" }
if ($headSha -ne $originSha) { Stop-Release "HEAD と origin/main が一致しません。未 push または要 pull の状態です" }
node tools/release/storeApi.mjs status --require-submittable
if ($LASTEXITCODE -ne 0) { Stop-Release "ストアの認証または提出可否の確認に失敗しました" }

if ($BumpType -eq "major") {
    npm.cmd run bump:major
    if ($LASTEXITCODE -ne 0) { Stop-Release "版上げに失敗しました" }
} else {
    npm.cmd run bump
    if ($LASTEXITCODE -ne 0) { Stop-Release "版上げに失敗しました" }
}
npm.cmd run build:release
if ($LASTEXITCODE -ne 0) { Stop-Release 'ストア用ビルドに失敗しました。バンプ commit は未 push。git reset --hard HEAD~1 で戻せます' }

# push が完了してから提出し、提出失敗時も版は上げ直さない。
git push origin HEAD:main
if ($LASTEXITCODE -ne 0) { Stop-Release 'dist.zip は出来ています。origin の更新を取り込んでから手動で push し、npm run store:submit で提出してください' }
node tools/release/storeApi.mjs submit
if ($LASTEXITCODE -eq 3) {
    Write-Host '結果不明。npm run store:status で状況を確認してから判断してください（自動では再実行しません）。dist.zip 作成と push は完了済み' -ForegroundColor Red
    exit 3
} elseif ($LASTEXITCODE -ne 0) {
    Stop-Release '提出に失敗。dist.zip 作成と push は完了済み。原因を解消したら npm run store:submit で提出だけやり直せます（版は上げ直さない）'
}
Write-Host "ストアへ審査提出済み"
exit 0
