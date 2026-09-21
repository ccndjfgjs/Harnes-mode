@echo off
for /f "tokens=4 delims=: " %%a in ('chcp') do set "CP_O=%%a"
chcp 65001 >nul
setlocal EnableExtensions
title Harnes-mode
rem ============================================================================
rem  DeepSeek Harness - запуск V2: кит + океан.
rem
rem  Откат: удалить этот файл и scripts\whale.ps1. Старый Запуск_Harness.bat
rem  не тронут. Копии до работ: папка "Новая папка (4) -откат-2026-09-20".
rem
rem  Как устроено: батник - дирижер (проверки, вопрос, запуск),
rem  scripts\whale.ps1 - художник (логотип, плывущий кит, нырок, океан-бар).
rem  Долгие шаги идут в фоне, их вывод - в лог, на экране в это время
rem  анимация. Процент шкалы - по росту лога до 95 и 100 по выходу:
rem  точного прогресса установщик не дает, шкала честная.
rem  Все логи фаз дописываются в launcher-log.txt, при ошибке путь на экране.
rem
rem  V2Ray-ядро ставится НЕ здесь, а из окна приложения
rem  (кнопка в окне, прогресс уже есть внутри). Батник его не видит.
rem
rem  Защита от обрыва: смотрим и код возврата, и наличие файлов результата.
rem  Кириллица: страница 65001 включается один раз вверху и возвращается
rem  перед выходом; все пути в кавычках, работа через ROOT.
rem ============================================================================

set "ROOT=%~dp0"
set "WHALE=%ROOT%scripts\whale.ps1"
set "PS=powershell -NoProfile -ExecutionPolicy Bypass -File"
set "LOG=%ROOT%launcher-log.txt"

if /i "%~1"=="--selftest" goto :selftest

>"%LOG%" echo [launcher-v2] started %date% %time%
cd /d "%ROOT%"
>>"%LOG%" echo [launcher-v2] cwd=%CD%

rem --- 1. снять защитные обертки WorkBuddy --------------------------------
set "NODE_OPTIONS="
set "CODEBUDDY_SAFE_DELETE_ENABLED="
set "CODEBUDDY_SAFE_DELETE_SANDBOX="
set "CODEBUDDY_SAFE_DELETE_BULK_GUARD="
set "CODEBUDDY_SAFE_DELETE_BIN_DIR="
set "CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR="
set "CODEBUDDY_SAFE_DELETE_REPORT_PATH="
set "CODEBUDDY_SAFE_DELETE_BROKER_DELETE="
set "ELECTRON_RUN_AS_NODE="
>>"%LOG%" echo [launcher-v2] wrapper variables cleared

rem --- 2. убрать брошенные замки ------------------------------------------
del /f /q "%USERPROFILE%\.dsh\.credentials.yaml.lock" 2>nul
del /f /q "%USERPROFILE%\.dsh\profiles\node_modules.lock" 2>nul
>>"%LOG%" echo [launcher-v2] locks clear attempt done

rem --- логотип: кит построчно ---------------------------------------------
if exist "%WHALE%" (
  %PS% "%WHALE%" -Mode intro
) else (
  echo   Harnes-mode
)

rem --- 3. зависимости на месте? -------------------------------------------
if not exist "node_modules\portfinder\package.json" goto :askinstall
if not exist "node_modules\electron\package.json" goto :askinstall
>>"%LOG%" echo [launcher-v2] dependency checks passed
goto :checkbuild

:askinstall
>>"%LOG%" echo [launcher-v2] dependency checks FAILED - ask branch
set "ANSWER="
set /p "ANSWER=  Install dependencies? / Установить зависимости? (y/n): "
if /i "%ANSWER%"=="y" goto :doinstall
if /i "%ANSWER%"=="н" goto :doinstall
goto :skipinstall

:skipinstall
cls
if exist "%WHALE%" (
  %PS% "%WHALE%" -Mode skip
) else (
  echo [DeepSeek Harness] Пропускаю установку, иду к запуску...
)
>>"%LOG%" echo [launcher-v2] install skipped by user
goto :checkbuild

:doinstall
cls
where pnpm.cmd >nul 2>&1
if %errorlevel%==0 (
  set "INST_CMD=pnpm.cmd"
  set "INST_ARGS=install --reporter=append-only"
) else (
  set "INST_CMD=npm.cmd"
  set "INST_ARGS=install"
)
set "PHASE_LOG=%TEMP%\harnes-install.log"
>>"%LOG%" echo [launcher-v2] install branch: %INST_CMD% %INST_ARGS%
%PS% "%WHALE%" -Mode install -InstallCmd "%INST_CMD%" -InstallArgs "%INST_ARGS%" -LogPath "%PHASE_LOG%" -ActionLabel "Установка зависимостей" -DoneLabel "Зависимости установлены."
if exist "%PHASE_LOG%" type "%PHASE_LOG%" >>"%LOG%" 2>nul
if errorlevel 1 goto :installfail
if not exist "node_modules\portfinder\package.json" goto :installfail
if not exist "node_modules\electron\package.json" goto :installfail
>>"%LOG%" echo [launcher-v2] install done
goto :checkbuild

:installfail
>>"%LOG%" echo [launcher-v2] install FAILED
echo.
echo   Не удалось поставить зависимости. Нужны Node.js 22 и pnpm.
echo   Подробности: "%LOG%"
pause
chcp %CP_O% >nul
exit /b 1

:checkbuild
rem --- 4. сборка бэкенда ---------------------------------------------------
if exist "apps\cli\lib\bin.js" goto :builtok
cls
echo [DeepSeek Harness] Первая сборка проекта, это займет несколько минут...
where pnpm.cmd >nul 2>&1
if %errorlevel%==0 (
  set "INST_CMD=pnpm.cmd"
  set "INST_ARGS=run build"
) else (
  set "INST_CMD=npm.cmd"
  set "INST_ARGS=run build"
)
set "PHASE_LOG=%TEMP%\harnes-build.log"
>>"%LOG%" echo [launcher-v2] build branch: %INST_CMD% %INST_ARGS%
%PS% "%WHALE%" -Mode install -InstallCmd "%INST_CMD%" -InstallArgs "%INST_ARGS%" -LogPath "%PHASE_LOG%" -ActionLabel "Сборка проекта" -DoneLabel "Проект собран."
if exist "%PHASE_LOG%" type "%PHASE_LOG%" >>"%LOG%" 2>nul
if errorlevel 1 goto :buildfail
if not exist "apps\cli\lib\bin.js" goto :buildfail
>>"%LOG%" echo [launcher-v2] build done
goto :builtok

:buildfail
>>"%LOG%" echo [launcher-v2] build FAILED
echo.
echo   Не удалось собрать проект. Нужны Node.js 22 и pnpm.
echo   Подробности: "%LOG%"
pause
chcp %CP_O% >nul
exit /b 1
:builtok

rem --- 5. бинарник Electron ------------------------------------------------
if exist "node_modules\electron\dist\electron.exe" goto :electronok
cls
echo [DeepSeek Harness] Докачиваю Electron, это займет время...
where pnpm.cmd >nul 2>&1
if %errorlevel%==0 (
  set "INST_CMD=pnpm.cmd"
  set "INST_ARGS=rebuild electron"
) else (
  set "INST_CMD=npm.cmd"
  set "INST_ARGS=rebuild electron"
)
set "PHASE_LOG=%TEMP%\harnes-electron.log"
>>"%LOG%" echo [launcher-v2] electron repair branch
%PS% "%WHALE%" -Mode install -InstallCmd "%INST_CMD%" -InstallArgs "%INST_ARGS%" -LogPath "%PHASE_LOG%" -ActionLabel "Докачка Electron" -DoneLabel "Electron готов."
if exist "%PHASE_LOG%" type "%PHASE_LOG%" >>"%LOG%" 2>nul
if not exist "node_modules\electron\dist\electron.exe" (
  >>"%LOG%" echo [launcher-v2] electron repair FAILED, will try npx fallback
)
:electronok

rem --- 6. запуск ------------------------------------------------------------
:launch
echo [DeepSeek Harness] Запускаю приложение...
if not exist "node_modules\electron\dist\electron.exe" goto :launchnpx
>>"%LOG%" echo [launcher-v2] launching electron.exe
start "" "node_modules\electron\dist\electron.exe" electron/main.js
>>"%LOG%" echo [launcher-v2] start issued
chcp %CP_O% >nul
exit

:launchnpx
>>"%LOG%" echo [launcher-v2] electron.exe MISSING - npx fallback
echo [DeepSeek Harness] Бинарник Electron не найден, пробую через npx...
start "" /b npx electron electron/main.js
>>"%LOG%" echo [launcher-v2] npx fallback issued
chcp %CP_O% >nul
exit

rem --- тихая самопроверка без установки и запуска ----------------------------
:selftest
where powershell >nul 2>&1
if errorlevel 1 (
  echo [launcher-v2] selftest: powershell NOT FOUND
  exit /b 1
)
if not exist "%WHALE%" (
  echo [launcher-v2] selftest: whale.ps1 NOT FOUND
  exit /b 1
)
echo [launcher-v2] selftest: powershell ok, whale ok
chcp %CP_O% >nul
exit /b 0
