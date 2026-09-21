<#
.SYNOPSIS
    Windows Worker Container Network Lockdown

.DESCRIPTION
    Enforces a strict deny-by-default network policy inside the Windows Hyper-V container:
    - Removes the default gateway (0.0.0.0/0), preventing any direct internet access.
    - Strips subnet broadcast, multicast (224.0.0.0/4), and off-link local subnet routes.
    - If a proxy address is specified, installs a single explicit host route (/32)
      allowing traffic solely to the proxy sidecar.
    - Strips all non-loopback IPv6 routes and disables IPv6 bindings.
    - Verifies the sanitized routing table and emits LOCAL_ENGINEER_NETWORK_OK on success.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ContainerAddress,

    [Parameter(Mandatory = $true)]
    [string]$InterfaceMacAddress,

    [string]$ProxyAddress
)

$ErrorActionPreference = 'Stop'

function Assert-IPv4Address([string]$Address) {
    $parsed = [System.Net.IPAddress]::None
    if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsed) -or
        $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
        -not $Address.StartsWith('10.')) {
        throw 'LOCAL_ENGINEER_NETWORK_ADDRESS_INVALID'
    }
}

function Get-IPv4Routes([string]$Output) {
    $routes = @()
    foreach ($line in ($Output -split "`r?`n")) {
        if ($line -match '^\s*(?<destination>\d+(?:\.\d+){3})\s+(?<mask>\d+(?:\.\d+){3})\s+(?<gateway>\S+)\s+(?<interface>\d+(?:\.\d+){3})\s+(?<metric>\d+)\s*$') {
            $routes += [pscustomobject]@{
                Destination = $Matches.destination
                Mask = $Matches.mask
                Gateway = $Matches.gateway
                Interface = $Matches.interface
                Metric = [int]$Matches.metric
            }
        }
    }
    return @($routes)
}

function Invoke-NetworkCommand([string]$Executable, [string[]]$Arguments) {
    $output = & $Executable @Arguments 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "LOCAL_ENGINEER_NETWORK_COMMAND_FAILED:$output"
    }
}

Assert-IPv4Address $ContainerAddress
if ($ProxyAddress) {
    Assert-IPv4Address $ProxyAddress
    $containerPrefix = (($ContainerAddress -split '\.')[0..2] -join '.')
    $proxyPrefix = (($ProxyAddress -split '\.')[0..2] -join '.')
    if ($containerPrefix -ne $proxyPrefix) {
        throw 'LOCAL_ENGINEER_PROXY_SUBNET_INVALID'
    }
}
if ($InterfaceMacAddress -notmatch '^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$') {
    throw 'LOCAL_ENGINEER_NETWORK_MAC_INVALID'
}

$routeOutput = & route.exe print -4 | Out-String
if ($LASTEXITCODE -ne 0) {
    throw 'LOCAL_ENGINEER_ROUTE_QUERY_FAILED'
}
$macPattern = [regex]::Escape(($InterfaceMacAddress -replace ':', ' '))
$interfaceMatch = [regex]::Match($routeOutput, "(?im)^\s*(?<index>\d+)\.\.\.$macPattern\s")
if (-not $interfaceMatch.Success) {
    throw 'LOCAL_ENGINEER_NETWORK_INTERFACE_NOT_FOUND'
}
$interfaceIndex = [int]$interfaceMatch.Groups['index'].Value
$routes = @(Get-IPv4Routes $routeOutput)
$subnetRoutes = @($routes | Where-Object {
        $_.Interface -eq $ContainerAddress -and
        $_.Gateway -eq 'On-link' -and
        $_.Mask -ne '255.255.255.255' -and
        $_.Destination -notlike '127.*' -and
        $_.Destination -notlike '224.*'
    })
if ($subnetRoutes.Count -gt 1) {
    throw 'LOCAL_ENGINEER_NETWORK_SUBNET_AMBIGUOUS'
}
$proxyRoute = @()
if ($ProxyAddress) {
    $proxyRoute = @($routes | Where-Object {
            $_.Destination -eq $ProxyAddress -and
            $_.Mask -eq '255.255.255.255' -and
            $_.Gateway -eq $ProxyAddress -and
            $_.Interface -eq $ContainerAddress
        })
}

if ($subnetRoutes.Count -eq 1) {
    $subnet = $subnetRoutes[0]
    if ($subnet.Mask -ne '255.255.255.0' -or -not $subnet.Destination.StartsWith('10.')) {
        throw 'LOCAL_ENGINEER_NETWORK_SUBNET_INVALID'
    }
    if ($ProxyAddress -and $proxyRoute.Count -eq 0) {
        Invoke-NetworkCommand route.exe @('ADD', $ProxyAddress, 'MASK', '255.255.255.255', $ProxyAddress, 'METRIC', '1', 'IF', [string]$interfaceIndex)
    }
    Invoke-NetworkCommand route.exe @('DELETE', $subnet.Destination, 'MASK', $subnet.Mask)
} elseif ($ProxyAddress -and $proxyRoute.Count -ne 1) {
    throw 'LOCAL_ENGINEER_PROXY_ROUTE_MISSING'
}

$defaultRoutes = @($routes | Where-Object { $_.Destination -eq '0.0.0.0' -and $_.Interface -eq $ContainerAddress })
if ($defaultRoutes.Count -gt 0) {
    Invoke-NetworkCommand netsh.exe @('interface', 'ipv4', 'delete', 'route', '0.0.0.0/0', "interface=$interfaceIndex", 'store=active')
}
$multicastRoutes = @($routes | Where-Object { $_.Destination -eq '224.0.0.0' -and $_.Interface -eq $ContainerAddress })
if ($multicastRoutes.Count -gt 0) {
    Invoke-NetworkCommand netsh.exe @('interface', 'ipv4', 'delete', 'route', '224.0.0.0/4', "interface=$interfaceIndex", 'store=active')
}
$broadcastRoutes = @($routes | Where-Object { $_.Destination -eq '255.255.255.255' -and $_.Interface -eq $ContainerAddress })
if ($broadcastRoutes.Count -gt 0) {
    Invoke-NetworkCommand netsh.exe @('interface', 'ipv4', 'delete', 'route', '255.255.255.255/32', "interface=$interfaceIndex", 'store=active')
}

$ipv6Output = & route.exe print -6 | Out-String
if ($LASTEXITCODE -ne 0) {
    throw 'LOCAL_ENGINEER_ROUTE_QUERY_FAILED'
}
if ($ipv6Output -match "(?m)^\s*$interfaceIndex\s+\d+\s+fe80::/64\s") {
    Invoke-NetworkCommand netsh.exe @('interface', 'ipv6', 'delete', 'route', 'fe80::/64', "interface=$interfaceIndex", 'store=active')
}
if ($ipv6Output -match "(?m)^\s*$interfaceIndex\s+\d+\s+ff00::/8\s") {
    Invoke-NetworkCommand netsh.exe @('interface', 'ipv6', 'delete', 'route', 'ff00::/8', "interface=$interfaceIndex", 'store=active')
}

$verifiedRoutes = @(Get-IPv4Routes ((& route.exe print -4) | Out-String))
$unexpectedRoutes = @($verifiedRoutes | Where-Object {
        $loopback = $_.Interface -eq '127.0.0.1'
        $self = $_.Destination -eq $ContainerAddress -and $_.Mask -eq '255.255.255.255' -and $_.Gateway -eq 'On-link' -and $_.Interface -eq $ContainerAddress
        $proxy = $ProxyAddress -and $_.Destination -eq $ProxyAddress -and $_.Mask -eq '255.255.255.255' -and $_.Gateway -eq $ProxyAddress -and $_.Interface -eq $ContainerAddress
        -not ($loopback -or $self -or $proxy)
    })
if ($unexpectedRoutes.Count -ne 0) {
    throw 'LOCAL_ENGINEER_NETWORK_ROUTE_VERIFICATION_FAILED'
}
$verifiedProxyRoutes = @()
if ($ProxyAddress) {
    $verifiedProxyRoutes = @($verifiedRoutes | Where-Object {
            $_.Destination -eq $ProxyAddress -and $_.Mask -eq '255.255.255.255' -and $_.Gateway -eq $ProxyAddress -and $_.Interface -eq $ContainerAddress
        })
}
if (($ProxyAddress -and $verifiedProxyRoutes.Count -ne 1) -or (-not $ProxyAddress -and $verifiedProxyRoutes.Count -ne 0)) {
    throw 'LOCAL_ENGINEER_PROXY_ROUTE_VERIFICATION_FAILED'
}

$verifiedIpv6 = & route.exe print -6 | Out-String
$loopbackMatch = [regex]::Match($verifiedIpv6, '(?im)^\s*(?<index>\d+)\.\.\..*Loopback')
if (-not $loopbackMatch.Success) {
    throw 'LOCAL_ENGINEER_IPV6_LOOPBACK_NOT_FOUND'
}
$loopbackIndex = [int]$loopbackMatch.Groups['index'].Value
$unexpectedIpv6 = @()
foreach ($line in ($verifiedIpv6 -split "`r?`n")) {
    if ($line -match '^\s*(?<index>\d+)\s+\d+\s+(?<prefix>\S+)\s+') {
        $routeIndex = [int]$Matches.index
        $prefix = $Matches.prefix
        $loopback = $routeIndex -eq $loopbackIndex
        $selfLinkLocal = $routeIndex -eq $interfaceIndex -and $prefix -match '^fe80:.*\/128$'
        if (-not ($loopback -or $selfLinkLocal)) {
            $unexpectedIpv6 += "${routeIndex}:${prefix}"
        }
    }
}
if ($unexpectedIpv6.Count -ne 0) {
    throw 'LOCAL_ENGINEER_IPV6_ROUTE_VERIFICATION_FAILED'
}

Write-Output 'LOCAL_ENGINEER_NETWORK_OK'
