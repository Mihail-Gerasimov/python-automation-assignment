@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
rem Подготовка окружения, запуск заданий и автоматических проверок.
set "PYTHONUTF8=1"

pushd "%~dp0"
if errorlevel 1 goto folder_error

if exist ".venv\Scripts\python.exe" goto environment_ready
set "CANDIDATE_PYTHON=py -3"
%CANDIDATE_PYTHON% -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>&1
if errorlevel 1 set "CANDIDATE_PYTHON=python"
%CANDIDATE_PYTHON% -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>&1
if errorlevel 1 goto python_error
%CANDIDATE_PYTHON% -m venv --clear .venv
if errorlevel 1 goto failed

:environment_ready
".venv\Scripts\python.exe" -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>&1
if errorlevel 1 goto python_error

echo [1/4] Установка зависимостей...
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check --require-hashes -r requirements.txt
if errorlevel 1 goto failed

echo [2/4] Обработка реестра...
".venv\Scripts\python.exe" "zadanie_1\process_registry.py"
if errorlevel 1 goto failed

echo [3/4] Расчёт выполнения плана...
".venv\Scripts\python.exe" "zadanie_3\plan.py"
if errorlevel 1 goto failed

echo [4/4] Проверка заданий...
".venv\Scripts\python.exe" -m unittest discover -s zadanie_1 -p "test_*.py" -v
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m unittest discover -s zadanie_3 -p "test_*.py" -v
if errorlevel 1 goto failed

echo.
echo Готово. Результат находится в zadanie_1\Результат.xlsx.
echo Задание 2: zadanie_2\Задание_2.md. Пояснения: Решение.md.
echo Работа с ИИ: Работа_с_ИИ.md.
popd
pause
exit /b 0

:python_error
echo Нужен работающий Python 3.10 или новее.
echo Для новой среды должна работать команда py -3 или python.
echo Если .venv уже существует, проверьте версию Python внутри неё.

:failed
echo Выполнение прервано. Причина указана выше.
popd
pause
exit /b 1

:folder_error
echo Не удалось открыть папку проекта.
pause
exit /b 1
