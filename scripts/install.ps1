# Luculent Browser Driver - Automated Zero-Dependency Installer for Windows
# Usage: powershell -c "irm https://raw.githubusercontent.com/LuculentTechnology/luculent-browser-driver/main/scripts/install.ps1 | iex"

$ErrorActionPreference = 'Stop'

Write-Host "=== Luculent Browser Driver Auto-Installer ===" -ForegroundColor Cyan
Write-Host "Setting up local relay for AI agents (Claude, Cursor, Codex, Gemini)..."

$installDir = Join-Path $HOME ".luculent\browser-driver"
$binDir = Join-Path $HOME ".luculent\bin"
$runtimeDir = Join-Path $HOME ".luculent\runtime"

New-Item -ItemType Directory -Force -Path $installDir, $binDir, $runtimeDir | Out-Null

# 1. Check or Auto-Install Node Runtime
$nodeExe = $null

# Check if an existing Node 20+ is available
$sysNode = Get-Command node -ErrorAction SilentlyContinue
if ($sysNode) {
    try {
        $ver = & $sysNode.Source -v
        $major = [int]($ver -replace '^v(\d+)\..*$', '$1')
        if ($major -ge 20) {
            $nodeExe = $sysNode.Source
            Write-Host "✓ Detected existing Node.js $ver ($nodeExe)" -ForegroundColor Green
        }
    } catch {}
}

# If no compatible Node found, check portable runtime directory
if (-not $nodeExe) {
    $portableNode = Join-Path $runtimeDir "node.exe"
    if (Test-Path $portableNode) {
        $nodeExe = $portableNode
        Write-Host "✓ Detected portable Node runtime in $runtimeDir" -ForegroundColor Green
    }
}

# If still missing, automatically install portable Node (zero user action needed)
if (-not $nodeExe) {
    Write-Host "→ Node 20+ not detected in system. Auto-installing portable runtime..." -ForegroundColor Yellow
    
    $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
    $nodeVersion = "v22.11.0"
    $zipName = "node-$nodeVersion-win-$arch.zip"
    $downloadUrl = "https://nodejs.org/dist/$nodeVersion/$zipName"
    $zipPath = Join-Path $env:TEMP $zipName
    
    Write-Host "  Downloading portable Node runtime ($nodeVersion $arch)..."
    Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -UseBasicParsing
    
    Write-Host "  Extracting runtime to $runtimeDir..."
    $extractTemp = Join-Path $env:TEMP "node-extract-$([Guid]::NewGuid())"
    Expand-Archive -Path $zipPath -DestinationPath $extractTemp -Force
    
    $extractedFolder = Get-ChildItem -Path $extractTemp -Directory | Select-Object -First 1
    Copy-Item -Path (Join-Path $extractedFolder.FullName "node.exe") -Destination (Join-Path $runtimeDir "node.exe") -Force
    
    Remove-Item -Path $zipPath, $extractTemp -Recurse -Force -ErrorAction SilentlyContinue
    $nodeExe = Join-Path $runtimeDir "node.exe"
    Write-Host "✓ Portable Node runtime auto-installed successfully." -ForegroundColor Green
}

# 2. Stage/Sync Driver Files
Write-Host "→ Synchronizing Luculent Browser Driver relay..."
$repoUrl = "https://github.com/LuculentTechnology/luculent-browser-driver/archive/refs/heads/main.zip"
$driverZip = Join-Path $env:TEMP "lbd-main.zip"
Invoke-WebRequest -Uri $repoUrl -OutFile $driverZip -UseBasicParsing

$extractDir = Join-Path $env:TEMP "lbd-extract-$([Guid]::NewGuid())"
Expand-Archive -Path $driverZip -DestinationPath $extractDir -Force
$sourceRoot = Get-ChildItem -Path $extractDir -Directory | Select-Object -First 1

Copy-Item -Path (Join-Path $sourceRoot.FullName "*") -Destination $installDir -Recurse -Force
Remove-Item -Path $driverZip, $extractDir -Recurse -Force -ErrorAction SilentlyContinue

# Ensure minimal ws dependency exists or bundle is ready
if (-not (Test-Path (Join-Path $installDir "node_modules\ws"))) {
    Write-Host "  Installing relay dependencies..."
    Push-Location $installDir
    try {
        & $nodeExe -e "require('child_process').execSync('npm install --omit=dev --no-audit --no-fund', {stdio: 'ignore'})" 2>$null
    } catch {}
    Pop-Location
}

# 3. Create Global 'lbd' CLI Wrapper
$lbdCmd = Join-Path $binDir "lbd.cmd"
$cmdContent = @"
@echo off
setlocal
set "NODE_OPTIONS="
set "NODE_PATH="
"$nodeExe" "$installDir\src\cli.mjs" %*
exit /b %errorlevel%
"@
Set-Content -Path $lbdCmd -Value $cmdContent -Encoding Ascii

# Create PowerShell function wrapper
$lbdPs1 = Join-Path $binDir "lbd.ps1"
$ps1Content = @"
param([Parameter(ValueFromRemainingArguments=`$true)]`$args)
& "$nodeExe" "$installDir\src\cli.mjs" @args
"@
Set-Content -Path $lbdPs1 -Value $ps1Content -Encoding utf8

# Add binDir to User PATH if not present
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$binDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$binDir", "User")
    $env:PATH = "$env:PATH;$binDir"
    Write-Host "✓ Added $binDir to user PATH." -ForegroundColor Green
}

# 4. Mint Initial API Key
Write-Host "→ Minting your agent API key..."
$keyOutput = & "$nodeExe" "$installDir\src\cli.mjs" keys mint --name default-agent 2>&1
Write-Host $keyOutput -ForegroundColor Cyan

Write-Host "`n=== Installation Complete! ===" -ForegroundColor Green
Write-Host "1. Install the extension in Chrome: https://luculent.dev/beta (or Chrome Web Store)"
Write-Host "2. Start the relay: lbd start"
Write-Host "3. Connect your AI agent (Claude Desktop, Cursor, Codex, Gemini) using http://127.0.0.1:47800/mcp"
