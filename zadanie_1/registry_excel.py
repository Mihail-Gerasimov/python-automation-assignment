"""Чтение реестра, проверка структуры и безопасное сохранение результата XLSX."""

import math
import os
from contextlib import closing
from pathlib import Path
from tempfile import NamedTemporaryFile
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile

from openpyxl import Workbook, load_workbook
from openpyxl.cell.cell import Cell
from openpyxl.styles import Alignment, Font
from openpyxl.utils.exceptions import InvalidFileException
from openpyxl.worksheet.worksheet import Worksheet

from registry_rules import CheckResult, ResponseError, ServiceResponse, classify_response

CONTRACT_HEADERS = ("Строка", "Договор", "Код человека", "Клиент", "Сумма, руб.")
RESPONSE_HEADERS = ("Код человека", "Ответ сервиса", "Карточки", "Комментарий сервиса")
RESULT_HEADERS = ("Статус", "Карточка", "Пояснение")


class RegistryError(ValueError):
    """Ошибка входной книги или условий сохранения, понятная пользователю."""


def _cell_error(cell: Cell, message: str) -> RegistryError:
    return RegistryError(f"{cell.parent.title}!{cell.coordinate}: {message}")


def _text_key(cell: Cell) -> str:
    # Принимаем ключ только текстом — чтобы сохранить ведущие нули и точное сопоставление.
    if not isinstance(cell.value, str) or not cell.value.strip():
        raise _cell_error(cell, "ожидается непустой текстовый идентификатор")
    return cell.value


def _read_sheet(
    sheet: Worksheet, required: tuple[str, ...]
) -> tuple[list[str], list[tuple[Cell, ...]]]:
    # Читаем все строки с данными — чтобы не потерять строки за старой границей Excel-таблицы.
    rows = list(sheet.iter_rows())
    # Убираем пустой хвост — чтобы оформление листа не добавляло лишние договоры.
    while rows and all(cell.value is None for cell in rows[-1]):
        rows.pop()
    width = max((cell.column for row in rows for cell in row if cell.value is not None), default=0)
    if not rows:
        raise RegistryError(f"{sheet.title}: отсутствует строка заголовков")
    rows = [row[:width] for row in rows]
    headers = []
    for cell in rows[0]:
        if not isinstance(cell.value, str) or not cell.value.strip():
            raise _cell_error(cell, "отсутствует текстовый заголовок")
        if cell.value in headers:
            raise _cell_error(cell, f"повтор заголовка {cell.value!r}")
        headers.append(cell.value)
    missing = [name for name in required if name not in headers]
    if missing:
        raise RegistryError(
            f"{sheet.title}: отсутствуют обязательные столбцы: {', '.join(missing)}"
        )
    for row in rows:
        if all(cell.value is None for cell in row):
            raise RegistryError(f"{sheet.title}: строка {row[0].row} пустая внутри данных")
        for cell in row:
            if cell.data_type in ("f", "e"):
                raise _cell_error(cell, "формулы и ошибки Excel не поддерживаются; нужны значения")
    return headers, rows[1:]


def _read_responses(sheet: Worksheet) -> dict[str, CheckResult]:
    headers, rows = _read_sheet(sheet, RESPONSE_HEADERS)
    # Ищем столбцы по заголовкам — чтобы их перестановка не меняла результат.
    columns = {name: headers.index(name) for name in RESPONSE_HEADERS}
    results = {}
    for row in rows:
        key_cell = row[columns["Код человека"]]
        key = _text_key(key_cell)
        # Отклоняем второй ответ на одного человека — чтобы не выбирать его случайно.
        if key in results:
            raise _cell_error(key_cell, f"повтор кода человека {key!r}")
        response = ServiceResponse(
            row[columns["Ответ сервиса"]].value,
            row[columns["Карточки"]].value,
            row[columns["Комментарий сервиса"]].value,
        )
        try:
            results[key] = classify_response(response)
        except ResponseError as error:
            raise _cell_error(row[columns[error.field]], str(error)) from error
    return results


def _write_cell(cell: Cell, value, number_format: str = "General") -> None:
    if isinstance(value, str) and len(value) > 32767:
        raise _cell_error(cell, "текст превышает предел ячейки Excel (32767 символов)")
    cell.value = value
    cell.number_format = number_format
    if isinstance(value, str):
        # Явно оставляем строки текстом — чтобы =… и #N/A не стали формулой или ошибкой.
        cell.data_type = "s"


def _fill_result(source: Worksheet, target: Worksheet, responses: dict[str, CheckResult]) -> int:
    headers, rows = _read_sheet(source, CONTRACT_HEADERS)
    collisions = set(headers).intersection(RESULT_HEADERS)
    if collisions:
        raise RegistryError(f"Договоры: уже есть выходные столбцы: {', '.join(sorted(collisions))}")
    for column, name in enumerate([*headers, *RESULT_HEADERS], start=1):
        _write_cell(target.cell(1, column), name)
    contract_column = headers.index("Договор")
    person_column = headers.index("Код человека")
    amount_column = headers.index("Сумма, руб.")
    missing = classify_response(None)
    # Обрабатываем каждый договор отдельно — чтобы сохранить все договоры одного человека.
    for target_row, row in enumerate(rows, start=2):
        _text_key(row[contract_column])
        person = _text_key(row[person_column])
        amount = row[amount_column]
        if type(amount.value) not in (int, float) or not math.isfinite(amount.value):
            raise _cell_error(
                amount, "сумма должна быть конечным числом, а не текстом или пустотой"
            )
        for column, original in enumerate(row, start=1):
            number_format = original.number_format
            # Задаём формат номера и суммы — чтобы Excel показывал ведущие нули и копейки.
            if column == contract_column + 1:
                number_format = "@"
            elif column == amount_column + 1:
                number_format = "#,##0.00"
            _write_cell(target.cell(target_row, column), original.value, number_format)
        result = responses.get(person, missing)
        for column, value in enumerate(
            (result.status, result.card, result.explanation), start=len(headers) + 1
        ):
            _write_cell(target.cell(target_row, column), value)
    _format_result(target)
    return len(rows)


def _format_result(sheet: Worksheet) -> None:
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    header_font = Font(bold=True)
    alignment = Alignment(wrap_text=True)
    for cell in sheet[1]:
        cell.font = header_font
    for column in sheet.columns:
        width = max(len(str(cell.value or "")) for cell in column) + 3
        sheet.column_dimensions[column[0].column_letter].width = min(max(width, 12), 60)
        for cell in column:
            cell.alignment = alignment


def _validate_paths(source: Path, destination: Path) -> None:
    if not source.is_file():
        raise RegistryError(f"Входной файл не найден или не является файлом: {source}")
    if source.suffix.lower() != ".xlsx":
        raise RegistryError("Входной файл должен иметь расширение .xlsx")
    # Сверяем сами файлы и пути — чтобы ссылка не позволила перезаписать исходник.
    if source.resolve() == destination.resolve() or (
        destination.exists() and source.samefile(destination)
    ):
        raise RegistryError("Нельзя сохранять результат поверх исходного файла")
    if destination.is_symlink():
        raise RegistryError("Выходной путь не должен быть символической ссылкой")
    if destination.suffix.lower() != ".xlsx" or destination.is_dir():
        raise RegistryError("Выходной путь должен указывать на файл .xlsx")
    if not destination.parent.is_dir():
        raise RegistryError(f"Каталог результата не существует: {destination.parent}")


def _save_result(book: Workbook, destination: Path) -> None:
    temporary = None
    try:
        # Сначала пишем во временный файл — чтобы при сбое сохранить прежний результат.
        with NamedTemporaryFile(
            dir=destination.parent, prefix=f".{destination.stem}-", suffix=".xlsx", delete=False
        ) as handle:
            temporary = Path(handle.name)
        # Закрываем временный файл перед записью — чтобы его можно было заменить и в Windows.
        try:
            book.save(temporary)
            os.replace(temporary, destination)
        finally:
            # Удаляем временный файл при любом исходе — чтобы не оставлять незавершённые книги.
            temporary.unlink(missing_ok=True)
    except OSError as error:
        message = f"Не удалось сохранить {destination}: {error}"
        if temporary is not None and temporary.exists():
            message += f". Временный файл не удалён: {temporary}"
        raise RegistryError(message) from error


def enrich_registry(input_path: Path, output_path: Path) -> int:
    source, destination = Path(input_path), Path(output_path)
    try:
        _validate_paths(source, destination)
    except OSError as error:
        raise RegistryError(f"Не удалось проверить пути файлов: {error}") from error
    try:
        original = load_workbook(source, data_only=False)
    except (OSError, BadZipFile, InvalidFileException, ParseError, KeyError, ValueError) as error:
        raise RegistryError(f"Не удалось прочитать {source}: {error}") from error
    with closing(original), closing(Workbook()) as result:
        for name in ("Договоры", "Ответы"):
            if name not in original.sheetnames:
                raise RegistryError(f"В книге отсутствует лист {name!r}")
        # Считаем ответ один раз на человека — чтобы использовать его для всех его договоров.
        responses = _read_responses(original["Ответы"])
        result.active.title = "Договоры"
        count = _fill_result(original["Договоры"], result.active, responses)
        _save_result(result, destination)
    return count
