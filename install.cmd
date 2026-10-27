@echo off
rem Double-click or run from cmd: installs AsPycharm into VS Code. Arguments pass through (e.g. -Pull).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
