#Requires -Version 5.1
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Continue"

$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $AppDir

Write-Host ""
Write-Host "====================================================================" -ForegroundColor Cyan
Write-Host "   INSTALATOR: Debate Live Translator (PL -> EN)                    " -ForegroundColor Cyan
Write-Host "   Automatyczne wdrozenie na nowym laptopie (Windows 10 / 11)       " -ForegroundColor Cyan
Write-Host "====================================================================" -ForegroundColor Cyan
Write-Host ""

function Find-WorkingPython {
    # Odswiez zmienna PATH z rejestru Windows (przydatne zaraz po instalacji Pythona)
    $MachinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $UserPath    = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path    = "$UserPath;$MachinePath"

    $Candidates = @(
        "python",
        "$env:LocalAppData\Programs\Python\Python312\python.exe",
        "$env:LocalAppData\Programs\Python\Python311\python.exe",
        "$env:LocalAppData\Programs\Python\Python310\python.exe",
        "C:\Program Files\Python312\python.exe",
        "C:\Program Files\Python311\python.exe",
        "C:\Program Files\Python310\python.exe"
    )

    $FoundAny = $null
    foreach ($cmd in $Candidates) {
        try {
            $resolved = Get-Command $cmd -ErrorAction SilentlyContinue
            if (-not $resolved) { continue }
            $exePath = $resolved.Source
            if ($exePath -match "WindowsApps\\python") { continue }
            $verCheck = & $exePath -c "import sys; print(sys.version_info[0], sys.version_info[1])"
            if ($LASTEXITCODE -eq 0 -and "$verCheck".Trim() -match "^3 (10|11|12|13)") {
                if (-not $FoundAny) { $FoundAny = $exePath }
                cmd /c "`"$exePath`" -c `"import numpy, onnxruntime`" >nul 2>nul"
                if ($LASTEXITCODE -eq 0) {
                    return $exePath
                }
            }
        } catch {
            continue
        }
    }
    return $FoundAny
}

# 1. Sprawdzenie / instalacja środowiska Python 3.12
Write-Host "[1/4] Sprawdzanie srodowiska Python 3..." -ForegroundColor Yellow
$PythonExe = Find-WorkingPython

if (-not $PythonExe) {
    Write-Host "      -> Nie wykryto Pythona 3. Rozpoczynam automatyczna instalacje Python 3.12..." -ForegroundColor Magenta

    $WingetCmd = Get-Command winget -ErrorAction SilentlyContinue
    if ($WingetCmd) {
        Write-Host "      -> Instalacja przez Windows Package Manager (winget)..." -ForegroundColor Gray
        & winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
        $PythonExe = Find-WorkingPython
    }

    if (-not $PythonExe) {
        Write-Host "      -> Pobieranie oficjalnego instalatora Python 3.12.8 z python.org..." -ForegroundColor Gray
        $InstallerUrl  = "https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe"
        $InstallerPath = Join-Path $env:TEMP "python-3.12.8-amd64.exe"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $InstallerUrl -OutFile $InstallerPath -UseBasicParsing
        Write-Host "      -> Uruchamianie cichej instalacji Python 3.12.8 (moze potrwac ok. 45 sekund)..." -ForegroundColor Gray
        $proc = Start-Process -FilePath $InstallerPath -ArgumentList "/quiet InstallAllUsers=0 PrependPath=1 Include_test=0 Include_Launcher=1" -Wait -PassThru
        Remove-Item $InstallerPath -Force -ErrorAction SilentlyContinue
        $PythonExe = Find-WorkingPython
    }

    if (-not $PythonExe) {
        Write-Host "[BLAD] Nie udalo sie automatycznie zainstalowac Pythona 3.12." -ForegroundColor Red
        Write-Host "       Pobierz i zainstaluj Python 3.12 z https://www.python.org/downloads/ (zaznacz 'Add python.exe to PATH')." -ForegroundColor Red
        exit 1
    }
}

$PyVersion = & $PythonExe --version 2>&1
Write-Host "      [OK] Wykryto: $PyVersion ($PythonExe)" -ForegroundColor Green

# 2. Sprawdzenie i instalacja bibliotek (numpy + onnxruntime + msvc-runtime)
Write-Host ""
Write-Host "[2/4] Sprawdzanie bibliotek AI, DSP oraz runtime C++ (numpy, onnxruntime, msvc-runtime)..." -ForegroundColor Yellow
$TargetPython = $PythonExe

function Sync-VcRedistDlls($PyExe) {
    $PyDir = Split-Path -Parent $PyExe
    $CapiDir = Join-Path $PyDir "Lib\site-packages\onnxruntime\capi"
    $BundledRedist = Join-Path $AppDir "models\vc_redist"

    if (Test-Path $BundledRedist) {
        Copy-Item (Join-Path $BundledRedist "*.dll") -Destination $PyDir -Force -ErrorAction SilentlyContinue
        if (Test-Path $CapiDir) {
            Copy-Item (Join-Path $BundledRedist "*.dll") -Destination $CapiDir -Force -ErrorAction SilentlyContinue
        }
    }
    if (Test-Path $CapiDir) {
        Get-ChildItem -Path $PyDir -Filter "*140*.dll" -ErrorAction SilentlyContinue | ForEach-Object {
            Copy-Item $_.FullName -Destination $CapiDir -Force -ErrorAction SilentlyContinue
        }
    }
}

Sync-VcRedistDlls $TargetPython

cmd /c "`"$TargetPython`" -c `"import numpy, onnxruntime`" >nul 2>nul"
if ($LASTEXITCODE -ne 0) {
    Write-Host "      -> Instalowanie bibliotek msvc-runtime, numpy oraz onnxruntime..." -ForegroundColor Magenta
    & $TargetPython -m pip install --upgrade pip --quiet
    & $TargetPython -m pip install --upgrade msvc-runtime --quiet
    & $TargetPython -m pip install -r (Join-Path $AppDir "requirements.txt") --quiet
    Sync-VcRedistDlls $TargetPython

    cmd /c "`"$TargetPython`" -c `"import numpy, onnxruntime`" >nul 2>nul"
    if ($LASTEXITCODE -ne 0) {
        # Fallback do instalacji systemowego pakietu Microsoft Visual C++ Redistributable przez winget
        $WingetCmd = Get-Command winget -ErrorAction SilentlyContinue
        if ($WingetCmd) {
            Write-Host "      -> Doinstalowywanie Microsoft Visual C++ Redistributable 2015-2022 (x64)..." -ForegroundColor Gray
            & winget install -e --id Microsoft.VCRedist.2015+.x64 --accept-package-agreements --accept-source-agreements
        }
    }

    cmd /c "`"$TargetPython`" -c `"import numpy, onnxruntime`" >nul 2>nul"
    if ($LASTEXITCODE -ne 0) {
        # Fallback do .venv jesli globalny pip wymaga uprawnien
        $VenvDir    = Join-Path $AppDir ".venv"
        $VenvPython = Join-Path $VenvDir "Scripts\python.exe"
        if (-not (Test-Path $VenvPython)) {
            & $PythonExe -m venv $VenvDir
        }
        $TargetPython = $VenvPython
        & $TargetPython -m pip install --upgrade pip --quiet
        & $TargetPython -m pip install --upgrade msvc-runtime --quiet
        & $TargetPython -m pip install -r (Join-Path $AppDir "requirements.txt") --quiet
        Sync-VcRedistDlls $TargetPython
    }
}
Write-Host "      [OK] Biblioteki numpy, onnxruntime oraz biblioteki DLL C++ sa gotowe." -ForegroundColor Green

# 3. Weryfikacja / pobranie modelu neuronowego WeSpeaker CAM++ ONNX
Write-Host ""
Write-Host "[3/4] Weryfikacja modelu biometrii glosu (WeSpeaker CAM++ ONNX)..." -ForegroundColor Yellow
& $TargetPython -c "import neural_voice_id; neural_voice_id.get_ort_session()"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[BLAD] Test modelu ONNX nie powiodl sie." -ForegroundColor Red
    exit 1
}
Write-Host "      [OK] Silnik ONNX Runtime i model WeSpeaker CAM++ dzialaja poprawnie." -ForegroundColor Green
[System.IO.File]::WriteAllText((Join-Path $AppDir ".python_exe"), $TargetPython, [System.Text.Encoding]::ASCII)

# 4. Utworzenie skrótu na Pulpicie
Write-Host ""
Write-Host "[4/4] Tworzenie skrotu na Pulpicie..." -ForegroundColor Yellow
try {
    $DesktopDir   = [Environment]::GetFolderPath("Desktop")
    $ShortcutPath = Join-Path $DesktopDir "Debate Live Translator.lnk"
    $WshShell     = New-Object -ComObject WScript.Shell
    $Shortcut     = $WshShell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath       = Join-Path $AppDir "Uruchom_Translator.bat"
    $Shortcut.WorkingDirectory = $AppDir
    $Shortcut.Description      = "Uruchom Debate Live Translator (PL -> EN)"
    $Shortcut.IconLocation     = "shell32.dll,13"
    $Shortcut.Save()
    Write-Host "      [OK] Utworzono skrot na Pulpicie: Debate Live Translator" -ForegroundColor Green
} catch {
    Write-Host "      [INFO] Nie udalo sie utworzyc skrotu na Pulpicie (mozna uruchamiac przez Uruchom_Translator.bat)." -ForegroundColor Gray
}

Write-Host ""
Write-Host "====================================================================" -ForegroundColor Green
Write-Host "   WDROZENIE ZAKONCZONE SUKCESEM!                                   " -ForegroundColor Green
Write-Host "====================================================================" -ForegroundColor Green
Write-Host "1. Aby uruchomic aplikacje, kliknij dwukrotnie 'Uruchom_Translator.bat'"
Write-Host "   (lub skrot 'Debate Live Translator' na Pulpicie)."
Write-Host "2. Pamietaj, aby po podlaczeniu miksera / mikrofonu ustawic go w Windows"
Write-Host "   jako Domyslne urzadzenie nagrywajace (Ustawienia -> System -> Dzwiek)."
Write-Host "3. W zakladce 'Silnik AI i Audio' wklej klucz Google Gemini API."
Write-Host ""
