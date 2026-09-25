<#
The Windows proxy has one private adapter for its worker and the Docker default
NAT adapter for outbound traffic. HNS gives both adapters a default gateway.
Remove only the private gateway, then fail closed unless the NAT gateway is the
sole remaining default route. This script runs before the worker is started.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InternalAddress,
    [Parameter(Mandatory = $true)][string]$InternalMacAddress,
    [Parameter(Mandatory = $true)][string]$EgressAddress,
    [Parameter(Mandatory = $true)][string]$EgressMacAddress
)

$ErrorActionPreference = 'Stop'

function Get-VerifiedInterface([string]$Address, [string]$MacAddress) {
    $parsed = [System.Net.IPAddress]::None
    if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsed) -or
        $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
        $MacAddress -notmatch '^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$') {
        throw 'LOCAL_ENGINEER_PROXY_NETWORK_INPUT_INVALID'
    }
    $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $Address -ErrorAction Stop)
    if ($addresses.Count -ne 1) { throw 'LOCAL_ENGINEER_PROXY_NETWORK_INTERFACE_AMBIGUOUS' }
    $adapter = Get-NetAdapter -InterfaceIndex $addresses[0].InterfaceIndex -ErrorAction Stop
    if (($adapter.MacAddress -replace '[-:]', '').ToUpperInvariant() -ne
        ($MacAddress -replace '[-:]', '').ToUpperInvariant()) {
        throw 'LOCAL_ENGINEER_PROXY_NETWORK_MAC_MISMATCH'
    }
    return $addresses[0].InterfaceIndex
}

if ($InternalAddress -notmatch '^10\.\d{1,3}\.\d{1,3}\.2$' -or $InternalAddress -eq $EgressAddress) {
    throw 'LOCAL_ENGINEER_PROXY_NETWORK_INPUT_INVALID'
}
$internalIndex = Get-VerifiedInterface $InternalAddress $InternalMacAddress
$egressIndex = Get-VerifiedInterface $EgressAddress $EgressMacAddress
if ($internalIndex -eq $egressIndex) { throw 'LOCAL_ENGINEER_PROXY_NETWORK_INTERFACE_AMBIGUOUS' }

$internalDefaults = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -InterfaceIndex $internalIndex)
if ($internalDefaults.Count -gt 1) { throw 'LOCAL_ENGINEER_PROXY_NETWORK_DEFAULT_AMBIGUOUS' }
if ($internalDefaults.Count -eq 1) {
    $internalDefaults[0] | Remove-NetRoute -Confirm:$false -ErrorAction Stop
}

$defaults = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0')
if ($defaults.Count -ne 1 -or $defaults[0].InterfaceIndex -ne $egressIndex -or
    $defaults[0].NextHop -eq '0.0.0.0') {
    throw 'LOCAL_ENGINEER_PROXY_NETWORK_DEFAULT_UNSAFE'
}
$internalSubnet = ($InternalAddress -replace '\.2$', '.0/24')
$privateRoutes = @(Get-NetRoute -AddressFamily IPv4 -InterfaceIndex $internalIndex)
$unexpected = @($privateRoutes | Where-Object {
        $_.DestinationPrefix -notin @(
            $internalSubnet,
            "$InternalAddress/32",
            ($InternalAddress -replace '\.2$', '.255/32'),
            '224.0.0.0/4',
            '255.255.255.255/32'
        ) -or $_.NextHop -ne '0.0.0.0'
    })
if ($unexpected.Count -ne 0 -or
    @($privateRoutes | Where-Object DestinationPrefix -eq $internalSubnet).Count -ne 1) {
    throw 'LOCAL_ENGINEER_PROXY_NETWORK_ROUTE_UNSAFE'
}

Write-Output 'LOCAL_ENGINEER_PROXY_NETWORK_OK'
