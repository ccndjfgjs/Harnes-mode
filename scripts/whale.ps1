# ============================================================
#  Harnes-mode :: whale.ps1
#  ASCII-кит для лаунчера + три режима анимации.
#
#  Режимы:
#    intro    — построчная отрисовка кита (логотип при старте)
#    install  — кит плывёт, снизу прогресс-бар-океан, в фоне команда фазы
#    skip     — кит ныряет в воду (отказ от установки)
#
#  Запуск:
#    powershell -NoProfile -ExecutionPolicy Bypass -File whale.ps1 -Mode intro
#
#  Адаптация для Новой папки (4) относительно референса:
#    1. install больше не повторяет intro (логотип показывает батник один раз).
#    2. Добавлены подписи фазы: -ActionLabel (что делаем) и -DoneLabel
#       (чем кончили) — один и тот же режим обслуживает установку,
#       сборку и докачку Electron с честными текстами.
#    3. Рисунок кита и анимации не тронуты.
# ============================================================

param(
    [ValidateSet('intro','install','skip')]
    [string]$Mode = 'intro',

    # команда фазы и лог — для режима install
    [string]$InstallCmd  = 'npm',
    [string]$InstallArgs = 'install',
    [string]$LogPath     = "$env:TEMP\harnes-install.log",

    # подписи фазы (адаптация 2)
    [string]$ActionLabel = 'Установка зависимостей',
    [string]$DoneLabel   = 'Зависимости установлены.'
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ------------------------------------------------------------
#  1. КИТ
# ------------------------------------------------------------
# Силуэт логотипа DeepSeek: округлое тело, белое брюхо слева,
# хвостовой плавник справа вверху, глаз — просвет в правой части.

$WhaleArt = @'
                              ▄▄        ▄▄
             ▄▄▄▄▄▄▄▄         ███▄    ████
         ▄█████████████▄      █████▄▄█████
       ▄██████████████████▄    ███████████
     ▄███████████████████████   █████████
    █████████████████████████████████████
   ██████▀▀        ▀▀████████████████████
  █████▀               ▀████  ██████████
 █████                   ███ ▄  ████████
 ████                    ███   ▀████████
 ████                    ▀██▄   ████████
 █████                     ▀███████████
  █████▄                    ███████████
   ██████▄▄               ▄██████████▀
     ████████▄▄▄     ▄▄▄████████████▀
       ████████████████████████████
         ▀▀██████████████████▀▀
              ▀▀▀▀▀▀▀▀▀▀▀
'@ -split "`r?`n"

# Компактный кит для анимаций (быстрее перерисовывается)
$WhaleSmall = @'
        ▄▄       ▄▄
   ▄▄▄▄▄▄ ███▄ ▄███
 ▄████████████████
█████▀▀   ▀███████
████        ██ ████
████         ▀████
 █████▄    ▄█████▀
   ▀███████████▀
      ▀▀▀▀▀▀▀
'@ -split "`r?`n"

$WhaleWidth = ($WhaleSmall | Measure-Object -Property Length -Maximum).Maximum

# ------------------------------------------------------------
#  2. ПРИМИТИВЫ ОТРИСОВКИ
# ------------------------------------------------------------

function Get-ConsoleWidth {
    try { [Math]::Max(60, [Console]::WindowWidth - 1) } catch { 80 }
}

function Hide-Cursor { try { [Console]::CursorVisible = $false } catch { } }
function Show-Cursor { try { [Console]::CursorVisible = $true  } catch { } }

# Печатает строку в конкретной позиции, затирая хвост предыдущего кадра
function Write-At {
    param([int]$Row, [string]$Text, [ConsoleColor]$Color = 'Blue', [int]$Pad = 0)
    if ($Row -lt 0) { return }
    try {
        [Console]::SetCursorPosition(0, $Row)
        $w = if ($Pad -gt 0) { $Pad } else { Get-ConsoleWidth }
        Write-Host $Text.PadRight($w).Substring(0, $w) -ForegroundColor $Color -NoNewline
    } catch { }
}

# Волна: узор смещается по фазе, получается бегущая вода
function Get-WaterLine {
    param([int]$Width, [int]$Phase)
    $p = '~~-~~^~-~'
    $sb = New-Object System.Text.StringBuilder
    for ($x = 0; $x -lt $Width; $x++) {
        [void]$sb.Append($p[($x + $Phase) % $p.Length])
    }
    $sb.ToString()
}

# Прогресс-бар «океан»: заполненная часть — вода, пустая — точки
function Get-OceanBar {
    param([int]$Percent, [int]$Width = 40)
    $Percent = [Math]::Max(0, [Math]::Min(100, $Percent))
    $filled  = [int][Math]::Round($Width * $Percent / 100)
    '  [' + ('█' * $filled) + ('·' * ($Width - $filled)) + ("] {0,3}%" -f $Percent)
}

function Get-Top {
    try { [Console]::CursorTop } catch { 0 }
}

# ------------------------------------------------------------
#  3. РЕЖИМ intro — построчная отрисовка
# ------------------------------------------------------------

function Show-WhaleIntro {
    param([int]$DelayMs = 45)
    Write-Host ''
    foreach ($line in $WhaleArt) {
        Write-Host $line -ForegroundColor Blue
        Start-Sleep -Milliseconds $DelayMs
    }
    Write-Host ''
    Write-Host '        H A R N E S - M O D E' -ForegroundColor Cyan
    Write-Host '        DeepSeek Harness for Windows' -ForegroundColor DarkGray
    Write-Host ''
}

# ------------------------------------------------------------
#  4. РЕЖИМ install — кит плывёт, пока идёт фаза
# ------------------------------------------------------------
#  Кит движется слева направо и покачивается на волне.
#  Процент берётся из роста лог-файла: точного прогресса установщик
#  не даёт, поэтому шкала идёт до 95% и доводится до 100% по выходу.

function Start-WhaleSwim {
    $width    = Get-ConsoleWidth
    $top      = Get-Top
    $whaleH   = $WhaleSmall.Count
    $waterRow = $top + $whaleH + 1
    $barRow   = $waterRow + 2

    # запускаем команду фазы в фоне
    if (Test-Path $LogPath) { Remove-Item $LogPath -Force -ErrorAction SilentlyContinue }
    $proc = Start-Process -FilePath $InstallCmd -ArgumentList $InstallArgs `
                          -NoNewWindow -PassThru `
                          -RedirectStandardOutput $LogPath `
                          -RedirectStandardError  "$LogPath.err"

    Hide-Cursor
    $frame = 0
    $expectedLines = 400   # эмпирический ориентир для шкалы

    try {
        while (-not $proc.HasExited) {
            $phase  = $frame % 9
            $travel = [int]((($frame * 2) % ($width - $WhaleWidth - 4)))
            $bob    = if ((($frame / 4) % 2) -eq 0) { 0 } else { 1 }

            # кит
            for ($i = 0; $i -lt $whaleH; $i++) {
                $row = $top + $i + $bob
                Write-At -Row $row -Text ((' ' * $travel) + $WhaleSmall[$i]) -Color Blue -Pad $width
            }
            if ($bob -eq 1) { Write-At -Row $top -Text '' -Pad $width }

            # вода
            Write-At -Row $waterRow -Text (Get-WaterLine -Width $width -Phase $phase) -Color DarkCyan -Pad $width

            # прогресс
            $done = 0
            if (Test-Path $LogPath) {
                try { $done = (Get-Content $LogPath -ErrorAction SilentlyContinue).Count } catch { }
            }
            $pct = [Math]::Min(95, [int](100 * $done / $expectedLines))
            Write-At -Row $barRow -Text (Get-OceanBar -Percent $pct) -Color Cyan -Pad $width

            $frame++
            Start-Sleep -Milliseconds 110
        }

        Write-At -Row $barRow -Text (Get-OceanBar -Percent 100) -Color Cyan -Pad $width
    }
    finally {
        Show-Cursor
        try { [Console]::SetCursorPosition(0, $barRow + 2) } catch { }
    }

    if ($proc.ExitCode -ne 0) {
        Write-Host ''
        Write-Host "  Ошибка: $ActionLabel." -ForegroundColor Red
        Write-Host "  Лог: $LogPath" -ForegroundColor DarkGray
    } else {
        Write-Host ''
        Write-Host "  $DoneLabel" -ForegroundColor Green
    }
    exit $proc.ExitCode
}

# ------------------------------------------------------------
#  5. РЕЖИМ skip — кит ныряет (отказ от установки)
# ------------------------------------------------------------
#  Кит уходит вниз по дуге, строки ниже линии воды обрезаются,
#  затем всплеск и расходящиеся круги.

function Start-WhaleDive {
    $width    = Get-ConsoleWidth
    $top      = Get-Top
    $whaleH   = $WhaleSmall.Count
    $waterRow = $top + $whaleH + 1

    Hide-Cursor
    try {
        # 5.1 — погружение
        for ($step = 0; $step -le $whaleH + 1; $step++) {
            $drift = $step * 2                       # уход вправо по дуге

            for ($i = 0; $i -lt $whaleH; $i++) {
                $row = $top + $i + $step
                if ($row -ge $waterRow) { continue } # ниже воды не рисуем
                Write-At -Row $row -Text ((' ' * $drift) + $WhaleSmall[$i]) -Color Blue -Pad $width
            }
            # чистим освободившиеся строки сверху
            for ($c = 0; $c -lt $step; $c++) {
                Write-At -Row ($top + $c) -Text '' -Pad $width
            }

            Write-At -Row $waterRow -Text (Get-WaterLine -Width $width -Phase $step) -Color DarkCyan -Pad $width
            Start-Sleep -Milliseconds 90
        }

        # 5.2 — всплеск
        $splash = @(
            '            .  °  .            ',
            '         °   \ | /   °         ',
            '        .  -- ( ) --  .        ',
            '            °  |  °            '
        )
        foreach ($s in $splash) {
            Write-At -Row ($waterRow - 1) -Text ((' ' * 14) + $s) -Color White -Pad $width
            Write-At -Row $waterRow -Text (Get-WaterLine -Width $width -Phase (Get-Random -Max 9)) -Color Cyan -Pad $width
            Start-Sleep -Milliseconds 110
        }
        Write-At -Row ($waterRow - 1) -Text '' -Pad $width

        # 5.3 — круги на воде
        for ($r = 1; $r -le 6; $r++) {
            $pad   = [Math]::Max(0, 20 - $r * 2)
            $ring  = (' ' * $pad) + '(' + ('·' * ($r * 3)) + ')'
            Write-At -Row $waterRow -Text $ring -Color DarkCyan -Pad $width
            Start-Sleep -Milliseconds 120
        }
        Write-At -Row $waterRow -Text (Get-WaterLine -Width $width -Phase 0) -Color DarkCyan -Pad $width
    }
    finally {
        Show-Cursor
        try { [Console]::SetCursorPosition(0, $waterRow + 2) } catch { }
    }

    Write-Host ''
    Write-Host '  Установка пропущена — запускаю проверку.' -ForegroundColor DarkGray
    Write-Host ''
}

# ------------------------------------------------------------
#  6. ТОЧКА ВХОДА
# ------------------------------------------------------------

switch ($Mode) {
    'intro'   { Show-WhaleIntro }
    'install' { Start-WhaleSwim }
    'skip'    { Start-WhaleDive }
}
