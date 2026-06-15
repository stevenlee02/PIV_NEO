# Literary Character Network — one-click launcher
# Usage: .\start.ps1

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── install frontend deps if needed ──
if (-not (Test-Path "$root\text-vis\frontend\node_modules")) {
    Write-Host ">>> First run: installing frontend dependencies..." -ForegroundColor Yellow
    Push-Location "$root\text-vis\frontend"
    npm install
    Pop-Location
    Write-Host ">>> Frontend deps ready" -ForegroundColor Green
}

# ── check / install backend deps if needed ──
$pivPython = "D:\anaconda3\envs\piv_env\python.exe"
if (Test-Path $pivPython) {
    & $pivPython -c "import fastapi, spacy, networkx, openai, dotenv" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host ">>> First run: installing backend dependencies..." -ForegroundColor Yellow
        & $pivPython -m pip install -r "$root\text-vis\backend\requirements.txt"
        Write-Host ">>> Backend deps ready" -ForegroundColor Green
    }
}

# ── launch backend ──
Write-Host "=== Starting backend (FastAPI :8000) ===" -ForegroundColor Cyan
Start-Process powershell -ArgumentList @"
-NoExit -Command `
  conda activate piv_env; `
  cd '$root\text-vis\backend'; `
  Write-Host 'Backend: http://localhost:8000' -ForegroundColor Green; `
  uvicorn app:app --reload --port 8000
"@

# ── launch frontend ──
Write-Host "=== Starting frontend (Vite :3000) ===" -ForegroundColor Cyan
Start-Process powershell -ArgumentList @"
-NoExit -Command `
  cd '$root\text-vis\frontend'; `
  Write-Host 'Frontend: http://localhost:3000' -ForegroundColor Green; `
  npm run dev
"@

Write-Host ""
Write-Host "Done! Open http://localhost:3000 in your browser." -ForegroundColor Yellow
Write-Host "Backend  docs at http://localhost:8000/docs" -ForegroundColor Yellow
