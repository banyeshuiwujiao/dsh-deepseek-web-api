# dsh-deepseek-web-api 安装与同步脚本 (幂等)
#
# 顺序是故意的：先验配置与测试，再看后端构建，最后才动运行时镜像。
# 任何一步失败都立刻停止（$ErrorActionPreference = 'Stop'），不留半成品状态。
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSCommandPath
Set-Location $src

Write-Host "[1/5] 配置结构自检（cordis.patch.yml 装配入口）..."
node test/config_check.mjs
if ($LASTEXITCODE -ne 0) { throw "配置自检失败，停止：先修 cordis.patch.yml" }

Write-Host "[2/5] smoke 与 DSH LlmRuntime 回归..."
node test/smoke.mjs
if ($LASTEXITCODE -ne 0) { throw "smoke 失败，停止" }
node test/preparecall_regression.mjs
if ($LASTEXITCODE -ne 0) { throw "prepareCall 回归失败，停止" }

Write-Host "[3/5] 检查 deepseek-web-api 后端构建状态..."
$backendDir = "C:\Users\Admin\DeepSeek_Harness\git-repo\deepseek-web-api"
$backendDist = Join-Path $backendDir "dist\index.js"
if (-not (Test-Path $backendDist)) {
  Write-Host "  dist 不存在，正在构建 deepseek-web-api..."
  Push-Location $backendDir
  cmd.exe /c "pnpm install && pnpm build"
  $buildExit = $LASTEXITCODE
  Pop-Location
  if ($buildExit -ne 0) { throw "后端构建失败（exit=$buildExit）" }
} else {
  # 只判断"存在"会放行过期 dist：真机上就因复用了手工起的旧进程，
  # 让注入的协议开关与 DSML 解析全部失效过一次。这里比对 src 最新改动时间。
  $distTime = (Get-Item $backendDist).LastWriteTime
  $newestSrc = (Get-ChildItem -Path (Join-Path $backendDir 'src') -Recurse -Include *.ts -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1)
  if ($newestSrc -and $newestSrc.LastWriteTime -gt $distTime) {
    Write-Host "  ⚠ dist 比源码旧：dist=$($distTime.ToString('yyyy-MM-dd HH:mm')) 而 $($newestSrc.Name) 改于 $($newestSrc.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))"
    Write-Host "     请在 $backendDir 执行 pnpm build 后重跑本脚本（旧 dist 会让新协议能力静默失效）"
  } else {
    Write-Host "  deepseek-web-api 构建就绪且不落后于源码 ($backendDist)"
  }
}
$backendRev = ""
if (Test-Path (Join-Path $backendDir '.git')) {
  $backendRev = (& git -C $backendDir rev-parse --short HEAD) 2>$null
  if (-not $backendRev) { $backendRev = "(读取失败)" }
}
Write-Host "  后端 git 版本: $backendRev"

Write-Host "[4/5] 同步插件至运行时镜像并校验一致性..."
$dst = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-deepseek-web-api'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Recurse -Force (Join-Path $src 'lib'), (Join-Path $src 'package.json'), (Join-Path $src 'README.md') $dst

# 逐文件比哈希：半复制/漏复制（比如新加了 lib/*.js 却没同步）都能当场发现。
$mismatch = @()
foreach ($rel in @('package.json', 'README.md') + (Get-ChildItem -Path (Join-Path $src 'lib') -Filter *.js | ForEach-Object { "lib/$($_.Name)" })) {
  $a = Join-Path $src $rel
  $b = Join-Path $dst $rel
  if (-not (Test-Path $b)) { $mismatch += "$rel (镜像缺失)"; continue }
  if ((Get-FileHash $a -Algorithm SHA256).Hash -ne (Get-FileHash $b -Algorithm SHA256).Hash) { $mismatch += $rel }
}
if ($mismatch.Count -gt 0) { throw "运行时镜像与源码不一致: $($mismatch -join ', ')" }
Write-Host "  已同步并校验一致: $dst"

Write-Host "[5/5] 提示: 请确认 dsh-client-config\profiles\desktop\cordis.patch.yml 已包含配置，"
Write-Host "       再执行 python scripts\sync-profiles.py --profile desktop，"
Write-Host "       最后重启 DeepSeek Harness.exe。"
Write-Host "OK: dsh-deepseek-web-api 安装就绪！"
