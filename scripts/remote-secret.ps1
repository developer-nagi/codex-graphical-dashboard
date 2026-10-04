param([ValidateSet('Protect','Read')][string]$Mode,[string]$Path)
$ErrorActionPreference = 'Stop'
if ($Mode -eq 'Protect') {
    $plain = [Console]::In.ReadToEnd()
    $secure = ConvertTo-SecureString -String $plain -AsPlainText -Force
    $encrypted = ConvertFrom-SecureString -SecureString $secure
    $temporary = $Path + '.new'
    [IO.File]::WriteAllText($temporary, $encrypted)
    Move-Item -LiteralPath $temporary -Destination $Path -Force
} else {
    $secure = ConvertTo-SecureString (Get-Content -LiteralPath $Path -Raw)
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}
