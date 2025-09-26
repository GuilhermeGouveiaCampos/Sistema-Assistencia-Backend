# start-bridge.ps1
# Inicia o bridge Serial -> HTTP para enviar UIDs do Arduino ao backend na nuvem.

param(
  [string]$Port = "",
  [string]$ApiBase = "https://sistema-assistencia-backend-production.up.railway.app",
  [string]$LeitorId = "PC-MESA01_COM5",
  [string]$LeitorKey = "SEGREDO123",
  [string]$BaudRate = "115200"
)

$ErrorActionPreference = "Stop"

Write-Host "Procurando Arduino..."

# Detecta porta automaticamente se não for informada
if ([string]::IsNullOrWhiteSpace($Port)) {
  try {
    $cand = Get-CimInstance Win32_SerialPort |
      Where-Object { $_.Name -match "USB-SERIAL CH340|Arduino|CH340" } |
      Select-Object -First 1
    if ($null -eq $cand) {
      Write-Host "Nenhum Arduino encontrado. Informe manualmente com: .\start-bridge.ps1 -Port COM5"
      exit 1
    }
    $Port = $cand.DeviceID  # Ex.: COM5
  } catch {
    Write-Host "Falha ao detectar porta automaticamente. Informe com: .\start-bridge.ps1 -Port COM5"
    exit 1
  }
}

Write-Host "Arduino na porta: $Port"

# Exporta variáveis de ambiente usadas pelo bridge
$env:SERIAL_PORT = $Port
$env:BAUD_RATE   = $BaudRate
$env:API_BASE    = $ApiBase
$env:LEITOR_ID   = $LeitorId
$env:LEITOR_KEY  = $LeitorKey

Write-Host "Configurações:"
Write-Host "  SERIAL_PORT = $env:SERIAL_PORT"
Write-Host "  BAUD_RATE   = $env:BAUD_RATE"
Write-Host "  API_BASE    = $env:API_BASE"
Write-Host "  LEITOR_ID   = $env:LEITOR_ID"
Write-Host "  LEITOR_KEY  = $env:LEITOR_KEY"

# Garante dependências
if (-not (Test-Path ".\node_modules\serialport")) {
  Write-Host "Instalando serialport..."
  npm install serialport --save | Out-Host
}
if (-not (Test-Path ".\node_modules\axios")) {
  Write-Host "Instalando axios..."
  npm install axios --save | Out-Host
}

# Roda o bridge
Write-Host "Iniciando bridge (routes/bridge-rfid.js)..."
node ".\routes\bridge-rfid.js"
