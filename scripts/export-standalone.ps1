<#
.SYNOPSIS
  Copies this package into a clean folder as a standalone open-source repo with FRESH git history (no monorepo
  history), then scans it for secrets and internal references. Nothing is pushed or published.
.EXAMPLE
  pwsh scripts/export-standalone.ps1 -Dest ..\exports\luculent-browser-driver
#>
param(
  [string]$Dest = (Join-Path ([IO.Path]::GetTempPath()) 'luculent-browser-driver-export'),
  [string]$Gitleaks = 'gitleaks',
  [string]$Repo = 'dProFoSho/luculent-browser-driver',   # GitHub owner/name the export will be pushed to
  [switch]$NoCommit
)
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSScriptRoot
$marker = '.lbd-export'

if (Test-Path $Dest) {
  if (-not (Test-Path (Join-Path $Dest $marker))) { throw "Refusing to overwrite $Dest (not a previous export: no $marker file)" }
  Remove-Item $Dest -Recurse -Force
}
New-Item -ItemType Directory -Force $Dest | Out-Null

# Files that only make sense inside the private monorepo, or are machine-local/generated.
$excludeDirs = @('node_modules', 'dist', 'out', '.playwright-mcp', 'codex-cwd')
$excludeFiles = @('config.json', 'INTERNAL.md', '*.log', 'results-*.json', 'export-standalone.ps1', 'default_chrome.py')
$rc = robocopy $src $Dest /E /NFL /NDL /NJH /NJS /NP /XD @excludeDirs /XF @excludeFiles
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
# robocopy /XF config.json would also drop legit files named config.json; restore the issue-template config.
Copy-Item (Join-Path $src '.github\ISSUE_TEMPLATE\config.yml') (Join-Path $Dest '.github\ISSUE_TEMPLATE\config.yml') -Force
Set-Content (Join-Path $Dest $marker) 'exported by scripts/export-standalone.ps1' -Encoding utf8

# Standalone package.json: public name, MIT, repository placeholder.
$pkgPath = Join-Path $Dest 'package.json'
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$pkg.name = 'luculent-browser-driver'
$pkg.license = 'MIT'
$pkg.PSObject.Properties.Remove('private')
$pkg | Add-Member -Force NoteProperty homepage 'https://luculent.dev/beta'
$pkg | Add-Member -Force NoteProperty repository ([ordered]@{ type = 'git'; url = "git+https://github.com/$Repo.git" })
$pkg | Add-Member -Force NoteProperty bugs ([ordered]@{ url = "https://github.com/$Repo/issues" })
# Docs link to the default repo name; point them at -Repo if it differs.
if ($Repo -ne 'dProFoSho/luculent-browser-driver') { Get-ChildItem $Dest -Recurse -File -Include *.md | ForEach-Object { $c = [IO.File]::ReadAllText($_.FullName); if ($c -match 'dProFoSho/luculent-browser-driver') { [IO.File]::WriteAllText($_.FullName, $c.Replace('dProFoSho/luculent-browser-driver', $Repo), (New-Object Text.UTF8Encoding $false)) } } }
$pkg | ConvertTo-Json -Depth 10 | Set-Content $pkgPath -Encoding utf8NoBOM

# Public export must not contain monorepo ticket ids. Strip them from the copy only.
Get-ChildItem $Dest -Recurse -File | Where-Object { $_.Extension -in '.js', '.mjs', '.md', '.ts', '.py', '.ps1' } | ForEach-Object {
  $c = [IO.File]::ReadAllText($_.FullName)
  $n = [regex]::Replace($c, '\s*\(LUC-\d+(?:,\s*LUC-\d+)*\)', '')
  if ($n -ne $c) { [IO.File]::WriteAllText($_.FullName, $n, (New-Object Text.UTF8Encoding $false)) }
}

# Internal-reference scan (paths, hostnames, tracker ids). Any hit fails the export.
$patterns = @('D:\\Luculent', 'D:/Luculent', 'BATTLESTATION', 'Battlestation', 'hermes-steward', '\bLUC-\d+', 'asana', 'Cosmech',
  '\b12205\d{10}\b', 'dProFoSho/luculent\b(?!-)', 'C:\\Users\\', 'gemini_runtime\.env', 'OPENROUTER_API_KEY=')
$hits = @()
Get-ChildItem $Dest -Recurse -File | Where-Object { $_.FullName -notmatch '\\\.git\\' -and $_.Extension -notin '.png', '.zip', '.ico' } | ForEach-Object {
  $f = $_
  foreach ($p in $patterns) { $m = Select-String -Path $f.FullName -Pattern $p -AllMatches -ErrorAction SilentlyContinue; if ($m) { $hits += $m | ForEach-Object { "$($f.FullName.Substring($Dest.Length+1)):$($_.LineNumber): $p" } } }
}
if ($hits.Count) { $hits | ForEach-Object { Write-Host "INTERNAL REF $_" }; throw "$($hits.Count) internal reference(s) found; fix them before publishing" }
Write-Host "internal-reference scan: 0 findings"

if (-not $NoCommit) {
  Push-Location $Dest
  git init -q -b main
  git add -A
  git -c user.name='Luculent' -c user.email='oss@luculent.dev' commit -q -m 'Luculent Browser Driver for AI Agents v0.2.0'
  Pop-Location
}

# Secret scan of the working tree and the fresh history.
if (Get-Command $Gitleaks -ErrorAction SilentlyContinue) {
  & $Gitleaks dir $Dest --no-banner --redact --exit-code 1
  if ($LASTEXITCODE -ne 0) { throw 'gitleaks found secrets in the files' }
  if (-not $NoCommit) { & $Gitleaks git $Dest --no-banner --redact --exit-code 1; if ($LASTEXITCODE -ne 0) { throw 'gitleaks found secrets in git history' } }
  Write-Host 'gitleaks: 0 findings'
} else { Write-Warning "gitleaks not found ($Gitleaks); secret scan skipped" }

Write-Host "Standalone export ready: $Dest"
Write-Host 'Next (manual): create the GitHub repo, then: git -C <dest> remote add origin <url>; git -C <dest> push -u origin main'
