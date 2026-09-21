# escape=`
ARG BASE_IMAGE=mcr.microsoft.com/windows/servercore:ltsc2025
ARG PYTHON_IMAGE=python:3.14-windowsservercore-ltsc2025

FROM ${PYTHON_IMAGE} AS python-runtime

FROM ${BASE_IMAGE} AS windows-base
SHELL ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';"]

ARG NODE_VERSION=24.21.0
ARG NODE_SHA256=158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541
RUN Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/v$env:NODE_VERSION/node-v$env:NODE_VERSION-win-x64.zip" -OutFile C:\node.zip; `
    if ((Get-FileHash C:\node.zip -Algorithm SHA256).Hash -ne $env:NODE_SHA256) { throw 'Node archive checksum mismatch' }; `
    Expand-Archive C:\node.zip -DestinationPath C:\node-extract; `
    Move-Item "C:\node-extract\node-v$env:NODE_VERSION-win-x64" C:\Node; `
    Remove-Item C:\node.zip,C:\node-extract -Recurse -Force

ENV PATH=C:\Node;C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem;C:\Windows\System32\WindowsPowerShell\v1.0

FROM windows-base AS windows-toolchain
SHELL ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';"]

RUN Invoke-WebRequest -UseBasicParsing https://aka.ms/vs/17/release/vs_BuildTools.exe -OutFile C:\vs_BuildTools.exe; `
    $signature = Get-AuthenticodeSignature C:\vs_BuildTools.exe; `
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'VS Build Tools signature invalid' }; `
    $process = Start-Process C:\vs_BuildTools.exe -ArgumentList @('--quiet','--wait','--norestart','--nocache','--installPath','C:\BuildTools','--add','Microsoft.VisualStudio.Workload.VCTools','--includeRecommended') -Wait -PassThru; `
    if ($process.ExitCode -notin @(0, 3010)) { throw "VS Build Tools failed: $($process.ExitCode)" }; `
    Remove-Item C:\vs_BuildTools.exe -Force

ENV RUSTUP_HOME=C:\Rust\rustup `
    CARGO_HOME=C:\Rust\cargo `
    PATH=C:\Rust\cargo\bin;C:\Node;C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem;C:\Windows\System32\WindowsPowerShell\v1.0

ARG RUSTUP_SHA256=6f4bef66261261fcb43131be8720bab817d403a09edec7455c371974b90bdb7e
RUN Invoke-WebRequest -UseBasicParsing https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe -OutFile C:\rustup-init.exe; `
    if ((Get-FileHash C:\rustup-init.exe -Algorithm SHA256).Hash -ne $env:RUSTUP_SHA256) { throw 'rustup-init checksum mismatch' }; `
    & C:\rustup-init.exe -y --no-modify-path --profile minimal --default-toolchain stable; `
    Remove-Item C:\rustup-init.exe -Force; `
    rustup component add rustfmt clippy

ARG CODEX_VERSION=0.144.6
ARG CODEX_SOURCE_SHA256=9f165c376c385f5df7df5fd6a0321ef1544bd133c47bdcf9d334d4b419c45d69
RUN Invoke-WebRequest -UseBasicParsing "https://github.com/openai/codex/archive/refs/tags/rust-v$env:CODEX_VERSION.zip" -OutFile C:\codex.zip; `
    if ((Get-FileHash C:\codex.zip -Algorithm SHA256).Hash -ne $env:CODEX_SOURCE_SHA256) { throw 'Codex source archive checksum mismatch' }; `
    Expand-Archive C:\codex.zip -DestinationPath C:\src; `
    Remove-Item C:\codex.zip -Force; `
    $source = Get-ChildItem C:\src -Directory | Select-Object -First 1; `
    Move-Item $source.FullName C:\src\codex

COPY network-proxy-main.rs C:\network-proxy-main.rs
ARG RUST_TOOLCHAIN_VERSION=1.98.1
RUN Copy-Item C:\network-proxy-main.rs C:\src\codex\codex-rs\network-proxy\src\main.rs -Force; `
    $rustVersion = ((& rustc +stable --version) -split ' ')[1]; `
    if ($rustVersion -ne $env:RUST_TOOLCHAIN_VERSION) { throw 'Rust toolchain version mismatch' }; `
    $cargoPath = 'C:\src\codex\codex-rs\network-proxy\Cargo.toml'; `
    $cargo = Get-Content -Raw $cargoPath; `
    $cargo = $cargo -replace '(?m)^(tokio\s*=.*)$', ('$1' + [Environment]::NewLine + 'toml = { workspace = true }'); `
    Set-Content -LiteralPath $cargoPath -Value $cargo -Encoding utf8; `
    $env:RUSTUP_TOOLCHAIN = 'stable'; `
    cmd.exe /D /S /C 'call C:\BuildTools\VC\Auxiliary\Build\vcvars64.bat >nul && cd /d C:\src\codex\codex-rs && cargo build --release -p codex-network-proxy --bin codex-network-proxy'

FROM windows-toolchain
SHELL ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';"]
ARG CODEX_VERSION=0.144.6
ARG GIT_VERSION=2.55.0
ARG GIT_WINDOWS_REVISION=1
ARG GIT_SHA256=31497e7968196332263459ee319d2524e3ebc5786ab895e2abad34ffdd4f4ebf

COPY --from=python-runtime C:\Python C:\Python
RUN Invoke-WebRequest -UseBasicParsing "https://github.com/git-for-windows/git/releases/download/v$env:GIT_VERSION.windows.$env:GIT_WINDOWS_REVISION/MinGit-$env:GIT_VERSION-64-bit.zip" -OutFile C:\mingit.zip; `
    if ((Get-FileHash C:\mingit.zip -Algorithm SHA256).Hash -ne $env:GIT_SHA256) { throw 'MinGit archive checksum mismatch' }; `
    Expand-Archive C:\mingit.zip -DestinationPath C:\MinGit; `
    Remove-Item C:\mingit.zip -Force; `
    New-Item -ItemType Directory -Force C:\npm | Out-Null; `
    npm install --global --prefix C:\npm "@openai/codex@$env:CODEX_VERSION"; `
    New-Item -ItemType Directory -Force C:\local-engineer,C:\workspace,C:\local-engineer\codex-home,C:\local-engineer\proxy-shared,C:\local-engineer\dependencies,C:\local-engineer\bin,C:\local-engineer\codex-home\tmp | Out-Null; `
    New-Item -ItemType File -Force C:\local-engineer\codex-home\tmp\arg0 | Out-Null; `
    Set-ItemProperty -Path C:\local-engineer\codex-home\tmp\arg0 -Name IsReadOnly -Value $true

COPY --from=windows-toolchain C:\src\codex\codex-rs\target\release\codex-network-proxy.exe C:\local-engineer\codex-network-proxy.exe
COPY proxy-sidecar.mjs C:\local-engineer\proxy-sidecar.mjs
COPY apply_patch.mjs C:\local-engineer\apply_patch.mjs
COPY apply_patch.cmd C:\local-engineer\bin\apply_patch.cmd
COPY apply_patch.bat C:\local-engineer\bin\apply_patch.bat
COPY apply_patch.ps1 C:\local-engineer\bin\apply_patch.ps1
COPY cargo.cmd C:\local-engineer\bin\cargo.cmd
COPY configure-worker-network.ps1 C:\local-engineer\configure-worker-network.ps1

ENV CODEX_HOME=C:\local-engineer\codex-home `
    RUSTUP_HOME=C:\Rust\rustup `
    PATH=C:\local-engineer\bin;C:\npm;C:\Python;C:\Python\Scripts;C:\MinGit\cmd;C:\Rust\cargo\bin;C:\Node;C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem;C:\Windows\System32\WindowsPowerShell\v1.0

RUN python --version; `
    node --version; `
    git --version; `
    codex --version; `
    rustc --version; `
    $toolRoots = @('C:\local-engineer','C:\npm','C:\Rust','C:\Node','C:\Python','C:\MinGit','C:\BuildTools','C:\src'); `
    foreach ($toolRoot in $toolRoots) { `
      icacls.exe $toolRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-93-2-1:(OI)(CI)F' '*S-1-5-93-2-2:(OI)(CI)RX' | Out-Null; `
      icacls.exe "$toolRoot\*" /reset /T /C /Q | Out-Null `
    }

WORKDIR C:\local-engineer
USER ContainerUser
CMD ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "while ($true) { Start-Sleep -Seconds 3600 }"]
