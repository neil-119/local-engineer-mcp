[CmdletBinding()]
param(
  [Parameter(ValueFromPipeline = $true)]
  $InputObject,

  [Parameter(ValueFromRemainingArguments = $true, Position = 0)]
  [string[]]$Arguments
)

begin {
  $piped = [System.Collections.Generic.List[string]]::new()
  $target = if (Test-Path 'C:\local-engineer\apply_patch.mjs') {
    'C:\local-engineer\apply_patch.mjs'
  } else {
    Join-Path $PSScriptRoot 'apply_patch.mjs'
  }
}

process {
  if ($null -ne $InputObject) {
    $piped.Add([string]$InputObject)
  }
}

end {
  if ($piped.Count -gt 0) {
    $piped | node $target @Arguments
  } else {
    node $target @Arguments
  }
  exit $LASTEXITCODE
}
