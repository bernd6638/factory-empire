@echo off
REM Baut eine eigenstaendige InputOverlay.exe (Python wird danach nicht mehr gebraucht)
cd /d "%~dp0"
py -m pip install --upgrade pyinstaller || python -m pip install --upgrade pyinstaller
py -m PyInstaller --onefile --noconsole --name InputOverlay input_overlay.py || python -m PyInstaller --onefile --noconsole --name InputOverlay input_overlay.py
echo.
echo Fertig! Die Datei liegt in: %~dp0dist\InputOverlay.exe
pause
