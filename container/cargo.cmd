@echo off
call C:\BuildTools\VC\Auxiliary\Build\vcvars64.bat >nul
"C:\Rust\cargo\bin\cargo.exe" %*
@exit /b %ERRORLEVEL%
