<#
.SYNOPSIS
  Lets a Chromium-based browser on Windows install the OctoHatchery extension from a .crx file.

.DESCRIPTION
  Adds entries to two machine policies in HKLM\SOFTWARE\Policies\<vendor>\<browser>:
  ExtensionInstallSources (where a .crx may come from) and ExtensionInstallAllowlist (the extension ID).
  Entries that are already there stay; an entry is added only once. Run it in an elevated PowerShell
  (Run as administrator), then restart the browser.

.PARAMETER Browser
  chrome, chromium, brave, edge, vivaldi or all. Default: every one of them that is installed.

.PARAMETER Source
  URL patterns a .crx may be downloaded from, e.g. "https://github.com/*". file:///* (a file dragged onto
  the extensions page) is always included.

.PARAMETER Id
  The extension ID. Default: the ID of the build this script came with.

.PARAMETER Remove
  Remove the entries this script adds (the file:///* source, the given sources and the ID). Other entries stay.

.EXAMPLE
  .\install-policy-windows.ps1
.EXAMPLE
  .\install-policy-windows.ps1 -Browser vivaldi -Source "https://github.com/*"
.EXAMPLE
  .\install-policy-windows.ps1 -Browser vivaldi -Remove
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string[]] $Browser = @(),
  [string[]] $Source = @(),
  [string] $Id = "__EXTENSION_ID__",
  [switch] $Remove
)
$ErrorActionPreference = "Stop"

# The build fills in the ID; an unfilled placeholder means none (split so the build does not replace it here).
if ($Id -eq ("__EXTENSION" + "_ID__")) { $Id = "" }
if ($Id -and $Id -notmatch '^[a-p]{32}$') { throw "Not an extension ID: $Id (32 letters a to p)" }

$keys = [ordered]@{
  chrome   = "Google\Chrome"
  chromium = "Chromium"
  brave    = "BraveSoftware\Brave"
  edge     = "Microsoft\Edge"
  vivaldi  = "Vivaldi"
}
$exe = @{
  chrome   = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
  chromium = @("$env:LOCALAPPDATA\Chromium\Application\chrome.exe", "$env:ProgramFiles\Chromium\Application\chrome.exe")
  brave    = @("$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe", "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe")
  edge     = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
  vivaldi  = @("$env:LOCALAPPDATA\Vivaldi\Application\vivaldi.exe", "$env:ProgramFiles\Vivaldi\Application\vivaldi.exe")
}

if ($Browser -contains "all") { $Browser = @($keys.Keys) }
elseif ($Browser.Count -eq 0) {
  $Browser = @($keys.Keys | Where-Object { $exe[$_] | Where-Object { Test-Path $_ } })
  if ($Browser.Count -eq 0) { throw "No supported browser found; name one with -Browser." }
}
foreach ($b in $Browser) { if (-not $keys.Contains($b)) { throw "Unknown browser: $b (chrome, chromium, brave, edge, vivaldi, all)" } }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin -and -not $WhatIfPreference) { throw "Run this in an elevated PowerShell (Run as administrator): the policies live under HKLM." }

$sources = @("file:///*") + $Source | Select-Object -Unique

# A list policy is a key with values named 1, 2, 3 ...; add a value only when no value holds it yet.
function Add-ListEntry([string] $key, [string] $value) {
  if (-not (Test-Path $key)) {
    if ($PSCmdlet.ShouldProcess($key, "create")) { New-Item -Path $key -Force | Out-Null }
  }
  $props = if (Test-Path $key) { (Get-Item $key).Property } else { @() }
  foreach ($p in $props) { if ((Get-ItemPropertyValue $key -Name $p) -eq $value) { "  already there: $value"; return } }
  $n = 1
  while ($props -contains "$n") { $n++ }
  if ($PSCmdlet.ShouldProcess("$key\$n", "set $value")) {
    New-ItemProperty -Path $key -Name "$n" -PropertyType String -Value $value -Force | Out-Null
    "  added $n = $value"
  }
}
function Remove-ListEntry([string] $key, [string] $value) {
  if (-not (Test-Path $key)) { return }
  foreach ($p in (Get-Item $key).Property) {
    if ((Get-ItemPropertyValue $key -Name $p) -eq $value -and $PSCmdlet.ShouldProcess("$key\$p", "remove $value")) {
      Remove-ItemProperty -Path $key -Name $p
      "  removed $p = $value"
    }
  }
}

foreach ($b in $Browser) {
  $base = "HKLM:\SOFTWARE\Policies\$($keys[$b])"
  "== $b ($base)"
  foreach ($s in $sources) {
    if ($Remove) { Remove-ListEntry "$base\ExtensionInstallSources" $s } else { Add-ListEntry "$base\ExtensionInstallSources" $s }
  }
  if ($Id) {
    if ($Remove) { Remove-ListEntry "$base\ExtensionInstallAllowlist" $Id } else { Add-ListEntry "$base\ExtensionInstallAllowlist" $Id }
  }
}
if (-not $Remove) {
  if (-not $Id) { Write-Warning "No extension ID given, so no ExtensionInstallAllowlist entry was added (pass -Id if a blocklist is set)." }
  "Restart the browser, open <browser>://policy and check that both policies show the status OK."
}
