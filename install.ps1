# dsh-deepseek-web-api 安装/自检脚本 (幂等)
#
# 顺序是故意的：先验配置与测试，再看后端构建，最后校验运行时接线。
# 任何一步失败都立刻停止（$ErrorActionPreference = 'Stop'），不留半成品状态。
#
# 第 4 步只做「校验」不复制：运行时通过 profile 的 link: 依赖（junction）直指本目录，
# 全机只有一份代码。改完代码不需要同步，重启客户端即可生效。
#
# 后端目录不再写死在本脚本里：不传 -BackendDir 就交给 lib/paths.js 的解析顺序
# （环境变量 DSH_DEEPSEEK_WEB_API_DIR → 指针文件 → 插件同级 → home 常见位置），
# 解析成功后把结果固化成指针 ~/.dsh/deepseek-web-api.json，供插件直接命中。
param(
  [string]$BackendDir = ""
)
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

Write-Host "[3/5] 解析并检查 deepseek-web-api 后端..."
$pathsModule = (Join-Path $src 'lib/paths.js') -replace '\\', '/'
if ($BackendDir -ne "") {
  # 显式指定：校验后写进指针，插件侧配置就不需要再出现绝对路径
  $resolved = node --input-type=module -e "
    import { existsSync } from 'node:fs'
    import { join } from 'node:path'
    import { writePointer, readGitRev, DEFAULT_POINTER_FILE } from 'file:///$pathsModule'
    const dir = process.argv[1]
    if (!existsSync(join(dir, 'dist', 'index.js'))) { console.error('NO_DIST'); process.exit(2) }
    console.log(writePointer(DEFAULT_POINTER_FILE, dir, readGitRev(dir)))
  " $BackendDir
  if ($LASTEXITCODE -ne 0) { throw "指定的后端目录不合法（缺 dist/index.js）: $BackendDir" }
  Write-Host "  指针已写入: $resolved"
}
# 读回解析结果（env → 指针 → 同级 → home 候选）
$probe = node --input-type=module -e "
  import { resolveServerDir } from 'file:///$pathsModule'
  const r = resolveServerDir({})
  console.log(JSON.stringify(r))
"
if ($LASTEXITCODE -ne 0) { throw "后端目录解析失败" }
$info = $probe | ConvertFrom-Json
if (-not $info.dir) { throw "解析不到 deepseek-web-api 后端目录（试过：$($info.notes -join ' | ')）。用 -BackendDir <路径> 指定一次，之后由指针文件接管。" }
$backendDir = $info.dir
$backendDist = Join-Path $backendDir "dist\index.js"
Write-Host "  后端目录 = $backendDir（来源 $($info.source)）"
if ($info.source -ne 'pointer') {
  # 首次靠 env/同级/发现定位到，就固化成指针：下次不再依赖猜测顺序（也让人看得见是谁定的）。
  $pinned = node --input-type=module -e "
    import { writePointer, readGitRev, DEFAULT_POINTER_FILE } from 'file:///$pathsModule'
    console.log(writePointer(DEFAULT_POINTER_FILE, process.argv[1], readGitRev(process.argv[1])))
  " $backendDir
  Write-Host "  指针已写入: $pinned"
} else {
  # 命中指针时过去什么都不写，指针里的 gitRev 就永远停在第一次落盘的那个版本；
  # 而排查文档教人拿它和后端实际 HEAD 对比判断"是否在跑旧构建"——过期基准会反过来冤枉新构建。
  # 这里只在版本对不上（或压根没记过）时回写一次，命中且一致则不动文件。
  $synced = node --input-type=module -e "
    import { readPointer, writePointer, readGitRev, shouldRefreshPointer, DEFAULT_POINTER_FILE } from 'file:///$pathsModule'
    const dir = process.argv[1]
    const pointer = readPointer(DEFAULT_POINTER_FILE)
    const actual = readGitRev(dir)
    if (!shouldRefreshPointer(pointer && pointer.gitRev, actual)) { console.log('OK'); process.exit(0) }
    console.log('REFRESHED:' + writePointer(DEFAULT_POINTER_FILE, dir, actual) + ' ' + pointer.gitRev + ' -> ' + actual)
  " $backendDir
  if ($LASTEXITCODE -ne 0) { throw "指针校验失败: $synced" }
  if ($synced -like 'REFRESHED:*') {
    Write-Host "  指针 gitRev 已过期，回写: $($synced.Substring('REFRESHED:'.Length))"
  } else {
    Write-Host "  指针 gitRev 与后端实际版本一致，未改动"
  }
}
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

Write-Host "[4/5] 校验运行时接线（link 依赖 = junction，全机只有一份代码）..."
# 2026-10-22 起不再往 node_modules 里拷代码：那等于维护两份副本，改错一份就静默跑旧代码，
# 而且 pnpm 视手抄目录为 extraneous，每次 `pnpm install` 都会把它挪进 .ignored（当天真删过一次）。
# 现在 profile 的 package.json 里有 link: 依赖，node_modules/dsh-deepseek-web-api 只是指回本目录的
# junction——改完即生效（仍需重启客户端才重新加载模块），不需要再同步。
$dst = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-deepseek-web-api'
$linkSpec = 'dsh-deepseek-web-api@link:' + ($src -replace '\\', '/')
if (-not (Test-Path $dst)) {
  throw "运行时未接线（$dst 不存在）。在该 profile 目录执行一次：`n  pnpm add `"$linkSpec`"`n然后重启 DeepSeek Harness.exe。"
}
$dstItem = Get-Item $dst -Force
if ($dstItem.LinkType -eq 'Junction' -or $dstItem.LinkType -eq 'SymbolicLink') {
  if (@($dstItem.Target) -notcontains $src) { throw "接线指向别处：$dst -> $($dstItem.Target)（期望 $src）" }
  Write-Host "  已接线（$($dstItem.LinkType)）：$dst -> $src"
} else {
  # 旧方案留下的实体副本：它会独立于源码漂移，必须显式换成 junction，别默默放行。
  throw "运行时是实体拷贝而不是 junction（改代码不会生效，pnpm 还会把它当 extraneous 删掉）。修复：`n  Remove-Item -Recurse -Force '$dst'`n  New-Item -ItemType Junction -Path '$dst' -Target '$src'`n或改成正式依赖：pnpm add `"$linkSpec`""
}

Write-Host "[5/5] 提示: 请确认 dsh-client-config\profiles\desktop\cordis.patch.yml 已包含配置，"
Write-Host "       再执行 python scripts\sync-profiles.py --profile desktop，"
Write-Host "       最后重启 DeepSeek Harness.exe（代码已 live 接线，不再需要拷贝同步）."
Write-Host "OK: dsh-deepseek-web-api 安装就绪！"
