[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

if ($MyInvocation.ExpectingInput) {
  $input | node C:\local-engineer\apply_patch.mjs @Arguments
} else {
  node C:\local-engineer\apply_patch.mjs @Arguments
}
exit $LASTEXITCODE
