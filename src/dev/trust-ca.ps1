# Run ONCE, elevated (Administrator), to trust the local Caddy dev CA so your browser accepts the dev TLS
# without warnings:  Right-click -> Run with PowerShell (as Admin), or:  powershell -ExecutionPolicy Bypass -File trust-ca.ps1
#
# Trusts:
#   - %USERPROFILE%\.pragmatic\dev-stack\certs\dev-ca.crt   the CA behind Caddy's *.lvh.me cert (the tenant admin panel at https://<tenant>.lvh.me)
#
# Tenant IdP CAs are NOT trusted here. Each tenant's IdP has its own name-constrained CA under
# %USERPROFILE%\.pragmatic\dev-stack\data\idp\<tenant>\tls\ca.crt (or PRAGMATIC_DEV_DATA_ROOT); trust it for your user with dev-ca-trust.ps1 (no elevation; it refuses any CA
# that is not name-constrained). See README.md, "Local platform IdP certificates".
$ErrorActionPreference = 'Stop'
$here = Join-Path $env:USERPROFILE '.pragmatic\dev-stack'
$certs = @('certs\dev-ca.crt')
foreach ($rel in $certs)
{
	$path = Join-Path $here $rel
	if (Test-Path $path)
	{
		Import-Certificate -FilePath $path -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
		Write-Host "trusted: $path"
	}
	else
	{
		Write-Warning "missing (skipped): $path"
	}
}
Write-Host "Done. Fully restart the browser to pick up the new trusted roots."
