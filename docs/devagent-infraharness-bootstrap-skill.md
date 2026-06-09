---
name: infraharness-bootstrap
description: 当用户在 DevAgent 中输入 infraHarness、infraHarness + 需求描述、infraHarness + 需求文档本地路径，或要求安装/初始化 InfraSpec Harness/SDD 工作流时触发。先检测 Node/npm，使用 npm exec 临时运行 InfraSpec CLI，执行 infraspec init --tools devagent --force --profile core；如用户提供需求，则继续桥接 infra-new 和 infra-review。
---

# infraHarness Bootstrap

## 目标

在当前项目根目录完成 InfraSpec for DevAgent 初始化。用户不需要手动 `npm install`，也不需要手动执行 `infraspec init`。

如果用户输入：

```text
infraHarness
```

只完成安装初始化。

如果用户输入：

```text
infraHarness 新增手机号验证码登录
infraHarness ./docs/需求说明.md
```

初始化成功后，继续读取 `.devagentrules/workflows/infra-new.md` 和 `.devagentrules/workflows/infra-review.md`，按 workflow 自动创建 change 并推进 review。

## 关键规则

- 必须在项目根目录执行。
- 不要把 InfraSpec 安装进业务项目依赖；使用 `npm exec --package` 临时执行。
- UOS/Linux 用 Bash；Windows 用 PowerShell。
- 当前 skill 不自动安装 Node.js。缺少 `node` 或 `npm` 时停止并提示用户安装。
- Node.js 要求：`>=20.19.0 <25.0.0`。
- Windows 优先调用 `npm.cmd`，避免 PowerShell 执行策略拦截 `npm.ps1`。
- 初始化失败时停止，不要继续生成需求、设计或任务文档。

## 选择脚本

如果无法判断系统，先运行：

```bash
node -e "console.log(process.platform)"
```

返回 `linux` 用 UOS/Linux 脚本；返回 `win32` 用 Windows 脚本。

## UOS/Linux

```bash
bash -lc '
set -euo pipefail

PACKAGE_NAME="${INFRASPEC_PACKAGE:-@bym-ai/infraspec@latest}"
DIAG_DIR="${TMPDIR:-/tmp}/infraharness-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DIAG_DIR"

echo "[infraHarness] cwd: $PWD"
echo "[infraHarness] diag: $DIAG_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "[infraHarness] ERROR: node not found. Install Node.js >=20.19.0 and <25.0.0, then reopen DevAgent/terminal."
  exit 2
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[infraHarness] ERROR: npm not found. Check Node.js installation and PATH."
  exit 2
fi

echo "[infraHarness] node: $(node -v)"
echo "[infraHarness] npm: $(npm -v)"

node -e "
const [major, minor] = process.versions.node.split(\".\").map(Number);
const ok = (major > 20 || (major === 20 && minor >= 19)) && major < 25;
if (!ok) {
  console.error(\"[infraHarness] ERROR: Node.js v\" + process.versions.node + \" is unsupported. Required >=20.19.0 <25.0.0.\");
  process.exit(1);
}
"

echo "[infraHarness] npm registry: $(npm config get registry 2>/dev/null || echo unknown)"

echo "[infraHarness] checking package: $PACKAGE_NAME"
if ! npm view "$PACKAGE_NAME" version --loglevel verbose >"$DIAG_DIR/npm-view.log" 2>&1; then
  echo "[infraHarness] ERROR: cannot access $PACKAGE_NAME from npm registry."
  echo "[infraHarness] log: $DIAG_DIR/npm-view.log"
  cat "$DIAG_DIR/npm-view.log"
  exit 3
fi

echo "[infraHarness] running init..."
if ! npm exec -y --loglevel verbose --package "$PACKAGE_NAME" -- infraspec init . --tools devagent --force --profile core >"$DIAG_DIR/npm-exec-init.log" 2>&1; then
  echo "[infraHarness] ERROR: infraspec init failed."
  echo "[infraHarness] log: $DIAG_DIR/npm-exec-init.log"
  cat "$DIAG_DIR/npm-exec-init.log"
  exit 4
fi

cat "$DIAG_DIR/npm-exec-init.log"

missing=()
for file in \
  "infraspec/config.yaml" \
  "AGENTS.md" \
  ".devagent/skills/infra-new-change/SKILL.md" \
  ".devagent/skills/infra-review-change/SKILL.md" \
  ".devagentrules/workflows/infra-new.md" \
  ".devagentrules/workflows/infra-review.md"
do
  [ -f "$file" ] || missing+=("$file")
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "[infraHarness] ERROR: missing generated files:"
  printf " - %s\n" "${missing[@]}"
  exit 5
fi

echo "[infraHarness] OK: InfraSpec initialized for DevAgent."
echo "[infraHarness] Restart or refresh DevAgent if slash commands are not visible."
'
```

## Windows PowerShell

```powershell
$ErrorActionPreference = "Stop"

$PackageName = if ($env:INFRASPEC_PACKAGE) { $env:INFRASPEC_PACKAGE } else { "@bym-ai/infraspec@latest" }
$DiagDir = Join-Path $env:TEMP ("infraharness-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Force -Path $DiagDir | Out-Null
$DiagLog = Join-Path $DiagDir "diagnostics.log"

function Log([string]$Message) {
  Write-Host $Message
  Add-Content -Path $DiagLog -Value $Message -Encoding UTF8
}

function Resolve-Cmd([string[]]$Names) {
  foreach ($Name in $Names) {
    $Cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($Cmd) { return $Cmd.Source }
  }
  return $null
}

function Run-Native([string]$Name, [string]$Command, [string[]]$ArgsList) {
  $Out = Join-Path $DiagDir "$Name.log"
  Log "[infraHarness] RUN: $Command $($ArgsList -join ' ')"
  & $Command @ArgsList > $Out 2>&1
  $Code = $LASTEXITCODE
  if (Test-Path $Out) {
    Get-Content $Out | ForEach-Object {
      Write-Host $_
      Add-Content -Path $DiagLog -Value $_ -Encoding UTF8
    }
  }
  Log "[infraHarness] EXIT($Name): $Code"
  return $Code
}

Log "[infraHarness] cwd: $(Get-Location)"
Log "[infraHarness] diag: $DiagDir"
Log "[infraHarness] powershell: $($PSVersionTable.PSVersion)"

$Node = Resolve-Cmd @("node.exe", "node")
$Npm = Resolve-Cmd @("npm.cmd", "npm")

Log "[infraHarness] node command: $Node"
Log "[infraHarness] npm command: $Npm"

if (-not $Node) {
  Log "[infraHarness] ERROR: node not found. This skill does not auto-install Node.js. Install Node.js >=20.19.0 <25.0.0, then reopen DevAgent/terminal."
  exit 2
}

if (-not $Npm) {
  Log "[infraHarness] ERROR: npm not found. Check Node.js installation and PATH."
  exit 2
}

$NodeVersion = (& $Node -v).Trim()
$NpmVersion = (& $Npm -v).Trim()
Log "[infraHarness] node: $NodeVersion"
Log "[infraHarness] npm: $NpmVersion"

$Parts = $NodeVersion.TrimStart("v").Split(".")
$Major = [int]$Parts[0]
$Minor = [int]$Parts[1]
$NodeOk = (($Major -gt 20) -or ($Major -eq 20 -and $Minor -ge 19)) -and ($Major -lt 25)
if (-not $NodeOk) {
  Log "[infraHarness] ERROR: unsupported Node.js $NodeVersion. Required >=20.19.0 <25.0.0."
  exit 2
}

$Registry = "unknown"
try { $Registry = ((& $Npm config get registry 2>$null) | Select-Object -Last 1).Trim() } catch {}
Log "[infraHarness] npm registry: $Registry"
Log "[infraHarness] npm_config_registry: $env:npm_config_registry"
Log "[infraHarness] HTTPS_PROXY: $env:HTTPS_PROXY"

Run-Native "npm-config" $Npm @("config", "list") | Out-Null

$ViewExit = Run-Native "npm-view" $Npm @("view", $PackageName, "version", "--loglevel", "verbose")
if ($ViewExit -ne 0) {
  Log "[infraHarness] ERROR: cannot access $PackageName from npm registry."
  Log "[infraHarness] logs: $DiagDir"
  exit 3
}

$InitExit = Run-Native "npm-exec-init" $Npm @(
  "exec", "-y", "--loglevel", "verbose",
  "--package", $PackageName,
  "--",
  "infraspec", "init", ".", "--tools", "devagent", "--force", "--profile", "core"
)
if ($InitExit -ne 0) {
  Log "[infraHarness] ERROR: infraspec init failed."
  Log "[infraHarness] logs: $DiagDir"
  exit 4
}

$Required = @(
  "infraspec/config.yaml",
  "AGENTS.md",
  ".devagent/skills/infra-new-change/SKILL.md",
  ".devagent/skills/infra-review-change/SKILL.md",
  ".devagentrules/workflows/infra-new.md",
  ".devagentrules/workflows/infra-review.md"
)

$Missing = @()
foreach ($File in $Required) {
  if (-not (Test-Path $File)) { $Missing += $File }
}

if ($Missing.Count -gt 0) {
  Log "[infraHarness] ERROR: missing generated files:"
  foreach ($File in $Missing) { Log " - $File" }
  Log "[infraHarness] logs: $DiagDir"
  exit 5
}

Log "[infraHarness] OK: InfraSpec initialized for DevAgent."
Log "[infraHarness] logs: $DiagDir"
Log "[infraHarness] Restart or refresh DevAgent if slash commands are not visible."
```

## 自动桥接 infra-new / infra-review

如果 `infraHarness` 后面带了需求描述或需求文档路径：

1. 如果是存在的本地路径，读取文件内容作为需求；路径不存在则停止。
2. 读取 `.devagentrules/workflows/infra-new.md`，按该 workflow 用需求创建 change。
3. 记录生成的 `infraspec/changes/<name>`。
4. 读取 `.devagentrules/workflows/infra-review.md`，以 `<name>` 推进 review。
5. 如果 review workflow 要求人工确认，就停下并提示继续执行 `/infra-review.md <name>`。

不要依赖当前会话已经加载 `/infra-new.md` 或 `/infra-review.md`，因为初始化刚完成时 DevAgent 可能还没刷新 slash commands。

## 排障要点

失败时优先让用户提供日志目录：

```text
[infraHarness] diag: ...
```

关键日志：

```text
diagnostics.log
npm-view.log / npm-view.log 等价日志
npm-exec-init.log / npm-exec-init.log 等价日志
```

快速判断：

- `node not found`：未安装 Node.js，或安装后没有重启 DevAgent/终端。
- `npm not found`：Node.js 安装不完整或 PATH 未生效。
- `unsupported Node.js`：版本不满足 `>=20.19.0 <25.0.0`。
- `cannot access @bym-ai/infraspec`：公司 npm 源未同步、registry/proxy/证书问题。
- `infraspec init failed`：包能访问但初始化失败，看 `npm-exec-init` 日志。
- Windows 出现 `npm.ps1 cannot be loaded`：PowerShell 执行策略拦截；脚本已优先使用 `npm.cmd`，检查日志中的 `npm command`。

Node.js 不会由本 skill 自动安装。如公司允许 Windows `winget`，可建议：

```powershell
winget install OpenJS.NodeJS.LTS
```
