"""Запуск обработки реестра из командной строки."""

import argparse
import sys
from pathlib import Path

from registry_excel import RegistryError, enrich_registry


def main() -> int:
    # Привязываем стандартные пути к скрипту — чтобы результат не зависел от папки запуска.
    task_directory = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(
        description="Обработать реестр договоров и сохранить отдельный результат XLSX.",
        epilog="При успехе предыдущий результат заменяется. Исходный файл не изменяется.",
    )
    parser.add_argument(
        "--input", type=Path, default=task_directory / "Реестр.xlsx", help="исходный XLSX"
    )
    parser.add_argument(
        "--output", type=Path, default=task_directory / "Результат.xlsx", help="выходной XLSX"
    )
    arguments = parser.parse_args()
    try:
        count = enrich_registry(arguments.input, arguments.output)
    except RegistryError as error:
        # Показываем причину без трассировки — чтобы было понятно, что исправить в файле или пути.
        print(f"Ошибка: {error}", file=sys.stderr)
        return 1
    print(f"Готово. Договоров: {count}. Результат: {arguments.output.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
