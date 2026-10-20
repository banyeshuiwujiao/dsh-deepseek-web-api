# dsh-deepseek-web-api 安装与同步脚本 (幂等)
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSCommandPath
Set-Location $src

Write-Host "[1/4] smoke 自检与 DSH LlmRuntime 回归..."
node test/smoke.mjs
if ($LASTEXITCODE -ne 0) { throw "smoke 失败，停止" }
node test/preparecall_regression.mjs
if ($LASTEXITCODE -ne 0) { throw "prepareCall 回归失败，停止" }

Write-Host "[2/4] 检查 deepseek-web-api 后端构建状态..."
$backendDir = "C:\Users\Admin\DeepSeek_Harness\git-repo\deepseek-web-api"
$backendDist = Join-Path $backendDir "dist\index.js"
if (-not (Test-Path $backendDist)) {
  Write-Host "  正在构建 deepseek-web-api..."
  Push-Location $backendDir
  cmd.exe /c "pnpm install && pnpm build"
  Pop-Location
} else {
  Write-Host "  deepseek-web-api 已构建就绪 ($backendDist)"
}

Write-Host "[3/4] 同步插件至运行时镜像..."
$dst = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-deepseek-web-api'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Recurse -Force (Join-Path $src 'lib'), (Join-Path $src 'package.json'), (Join-Path $src 'README.md') $dst
Write-Host "  已同步至: $dst"

Write-Host "[4/4] 提示: 请确认 dsh-client-config\profiles\desktop\cordis.patch.yml 已包含配置，"
Write-Host "       再执行 python scripts\sync-profiles.py --profile desktop，"
Write-Host "       最后重启 DeepSeek Harness.exe。"
Write-Host "OK: dsh-deepseek-web-api 安装就绪！"
