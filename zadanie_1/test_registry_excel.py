"""Проверки настоящих XLSX, сохранности файлов и публичного запуска обработки."""

import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from openpyxl import Workbook, load_workbook
from openpyxl.worksheet.table import Table

from registry_excel import RegistryError, enrich_registry

ROOT = Path(__file__).resolve().parent
CONTRACT_HEADERS = ["Строка", "Договор", "Код человека", "Клиент", "Сумма, руб."]
RESPONSE_HEADERS = ["Код человека", "Ответ сервиса", "Карточки", "Комментарий сервиса"]
RESULT_HEADERS = ["Статус", "Карточка", "Пояснение"]


class RegistryFilesTest(unittest.TestCase):
    def setUp(self):
        # Работаем во временной папке — чтобы тесты не меняли исходник и готовый результат.
        temporary = tempfile.TemporaryDirectory(prefix="реестр тест ")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.source = self.directory / "Входные данные.xlsx"
        self.output = self.directory / "Новый результат.xlsx"

    def write_source(self, contracts=None, responses=None, contract_headers=None):
        if contracts is None:
            contracts = [["R01", "00001", "P01", "Клиент", 500.05]]
        if responses is None:
            responses = [["P01", "Успешно", "REC-1", None]]
        with closing(Workbook()) as book:
            contracts_sheet = book.active
            contracts_sheet.title = "Договоры"
            contracts_sheet.append(contract_headers or CONTRACT_HEADERS)
            for row in contracts:
                contracts_sheet.append(row)
            answers = book.create_sheet("Ответы")
            answers.append(RESPONSE_HEADERS)
            for row in responses:
                answers.append(row)
            book.save(self.source)

    def change_source(self, change):
        with closing(load_workbook(self.source)) as book:
            change(book)
            book.save(self.source)

    def read_output(self):
        with closing(load_workbook(self.output, data_only=False)) as book:
            return list(book["Договоры"].values)

    def assert_rejected(self, message):
        before = self.source.read_bytes() if self.source.exists() else None
        # Оставляем старый результат — чтобы убедиться, что отказ его не затронет.
        self.output.write_bytes(b"previous result")
        with self.assertRaisesRegex(RegistryError, message):
            enrich_registry(self.source, self.output)
        self.assertEqual(self.output.read_bytes(), b"previous result")
        if before is not None:
            self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(set(self.directory.iterdir()), {self.source, self.output})

    def test_original_book_matches_independent_expectations(self):
        source = ROOT / "Реестр.xlsx"
        before = source.read_bytes()
        self.assertEqual(enrich_registry(source, self.output), 8)
        # Задаём ожидания вручную — чтобы тест не повторял возможную ошибку обработчика.
        expected = [
            ("R01", "00123", "Найдено", "REC-101"),
            ("R02", "00124", "Не найдено", None),
            ("R03", "00125", "Ошибка проверки", None),
            ("R04", "00991", "Найдено", "REC-101"),
            ("R05", "01001", "Нужна проверка", None),
            ("R06", "01002", "Ошибка проверки", None),
            ("R07", "00007", "Найдено", "REC-701"),
            ("R08", "00008", "Не найдено", None),
        ]
        with (
            closing(load_workbook(source)) as original,
            closing(load_workbook(self.output)) as result,
        ):
            self.assertEqual(result.sheetnames, ["Договоры"])
            sheet = result["Договоры"]
            rows = list(sheet.values)
            self.assertEqual(rows[0], tuple(CONTRACT_HEADERS + RESULT_HEADERS))
            self.assertEqual([row[:5] for row in rows[1:]], list(original["Договоры"].values)[1:])
            self.assertEqual([(row[0], row[1], row[5], row[6]) for row in rows[1:]], expected)
            self.assertEqual(sum(Decimal(str(row[4])) for row in rows[1:]), Decimal("28471.40"))
            # Проверяем ячейки сохранённой книги — чтобы увидеть реальные типы и форматы Excel.
            for row in sheet.iter_rows(min_row=2):
                self.assertEqual(row[1].data_type, "s")
                self.assertEqual(row[1].number_format, "@")
                self.assertEqual(row[4].data_type, "n")
                self.assertEqual(row[4].number_format, "#,##0.00")
                self.assertTrue(row[7].value)
            self.assertIn("Сервис временно недоступен", sheet["H4"].value)
            self.assertIn("отсутствует", sheet["H7"].value)
            self.assertEqual(sheet.auto_filter.ref, "A1:H9")
        self.assertEqual(source.read_bytes(), before)

    def test_changed_copy_replaces_previous_rows_and_results(self):
        self.source.write_bytes((ROOT / "Реестр.xlsx").read_bytes())
        enrich_registry(self.source, self.output)
        initial = self.read_output()
        enrich_registry(self.source, self.output)
        self.assertEqual(self.read_output(), initial)

        # Меняем копию — чтобы проверить добавление, удаление и пересчёт статусов договоров.
        def update(book):
            sheet = book["Договоры"]
            sheet.delete_rows(3)
            sheet.append(["R09", "00009", "P01", "Клиент Альфа", 1.01])
            sheet.append(["R10", "00010", "P09", "Новый клиент", 2.02])
            book["Ответы"]["C2"] = "REC-101;REC-102"
            book["Ответы"].append(["P09", "Успешно", "REC-901", None])

        self.change_source(update)
        before = self.source.read_bytes()
        self.assertEqual(enrich_registry(self.source, self.output), 9)
        rows = self.read_output()[1:]
        self.assertEqual(
            [row[0] for row in rows],
            ["R01", "R03", "R04", "R05", "R06", "R07", "R08", "R09", "R10"],
        )
        self.assertEqual(
            [(r[5], r[6]) for r in rows if r[2] == "P01"], [("Нужна проверка", None)] * 3
        )
        self.assertEqual(rows[-1][5:7], ("Найдено", "REC-901"))
        self.assertEqual(sum(Decimal(str(row[4])) for row in rows), Decimal("10024.43"))
        self.assertEqual(self.source.read_bytes(), before)

    def test_zero_and_one_contract_with_no_responses(self):
        for contracts in ([], [["R01", "00001", "P01", "Клиент", 0]]):
            with self.subTest(contracts=contracts):
                self.write_source(contracts=contracts, responses=[])
                self.assertEqual(enrich_registry(self.source, self.output), len(contracts))
                rows = self.read_output()
                self.assertEqual(len(rows), len(contracts) + 1)
                if contracts:
                    self.assertEqual(rows[1][4:7], (0, "Ошибка проверки", None))

    def test_column_order_and_all_original_fields_are_preserved(self):
        headers = ["Заметка", "Клиент", "Сумма, руб.", "Код человека", "Строка", "Договор"]
        row = ["Исходная заметка", "Клиент", -0.1, "P01", "R01", "000000001"]
        self.write_source(contracts=[row], contract_headers=headers)
        self.assertEqual(enrich_registry(self.source, self.output), 1)
        rows = self.read_output()
        self.assertEqual(rows[0], tuple(headers + RESULT_HEADERS))
        self.assertEqual(rows[1][:6], tuple(row))

    def test_hidden_rows_old_table_bounds_and_formatted_tail(self):
        self.write_source()

        def update(book):
            sheet = book["Договоры"]
            sheet.add_table(Table(displayName="OldRange", ref="A1:E2"))
            sheet.append(["R02", "00002", "P01", "Клиент", 0.1])
            sheet.row_dimensions[2].hidden = True
            sheet["K50"].number_format = "0.00"
            book["Ответы"].append(["UNUSED", "Успешно", "REC-X", None])

        self.change_source(update)
        self.assertEqual(enrich_registry(self.source, self.output), 2)
        self.assertEqual([r[1] for r in self.read_output()[1:]], ["00001", "00002"])

    def test_literal_formula_and_error_text_remain_text(self):
        self.write_source(
            contracts=[
                ["R01", "00001", "P01", "=1+1", 0.1],
                ["R02", "00002", "P01", "#N/A", 0],
            ],
            responses=[["P01", "Успешно", "=2+2", None]],
        )

        def literal_types(book):
            for address in ("D2", "D3"):
                book["Договоры"][address].data_type = "s"
            book["Ответы"]["C2"].data_type = "s"

        self.change_source(literal_types)
        self.assertEqual(enrich_registry(self.source, self.output), 2)
        with closing(load_workbook(self.output, data_only=False)) as book:
            for address, value in (("D2", "=1+1"), ("D3", "#N/A"), ("G2", "=2+2")):
                self.assertEqual(book["Договоры"][address].value, value)
                self.assertEqual(book["Договоры"][address].data_type, "s")

    def test_invalid_headers_and_missing_sheet_are_rejected(self):
        changes = [
            (lambda b: b.remove(b["Ответы"]), "Ответы"),
            (lambda b: setattr(b["Договоры"]["B1"], "value", "Номер"), "Договор"),
            (lambda b: setattr(b["Договоры"]["F1"], "value", "Договор"), "повтор"),
            (lambda b: setattr(b["Договоры"]["F1"], "value", "Статус"), "Статус"),
            (lambda b: setattr(b["Договоры"]["F2"], "value", "без заголовка"), "заголов"),
        ]
        for change, message in changes:
            with self.subTest(message=message):
                self.write_source()
                self.change_source(change)
                self.assert_rejected(message)

    def test_duplicate_and_invalid_service_responses_are_rejected(self):
        cases = [
            ([["P01", "Успешно", "REC-1", None]] * 2, "повтор"),
            ([["P01", "Ожидание", None, None]], "Ответы.*B2"),
            ([[None, "Успешно", None, None]], "Ответы.*A2"),
            ([["P01", "Успешно", 123, None]], "Ответы.*C2"),
            ([["P01", "Успешно", ";;", None]], "Ответы.*C2"),
        ]
        for responses, message in cases:
            with self.subTest(responses=responses):
                self.write_source(responses=responses)
                self.assert_rejected(message)

    def test_invalid_contract_cells_are_rejected(self):
        cases = [
            ("B2", 123),
            ("B2", None),
            ("C2", None),
            ("C2", True),
            ("C2", "  "),
            ("E2", "500.05"),
            ("E2", None),
            ("E2", True),
            ("D2", "=1+1"),
            ("D2", "#N/A"),
        ]
        for address, value in cases:
            with self.subTest(address=address, value=value):
                self.write_source()
                self.change_source(
                    lambda b, address=address, value=value: setattr(
                        b["Договоры"][address], "value", value
                    )
                )
                self.assert_rejected(f"Договоры.*{address}")

    def test_internal_blank_row_is_not_silently_removed(self):
        self.write_source(
            contracts=[
                ["R01", "00001", "P01", "Клиент", 1],
                [None] * 5,
                ["R02", "00002", "P01", "Клиент", 2],
            ]
        )
        self.assert_rejected("Договоры.*3.*пуст")

    def test_invalid_paths_and_corrupt_workbook(self):
        with self.assertRaisesRegex(RegistryError, "Входной файл"):
            enrich_registry(self.source, self.output)
        self.source.write_bytes(b"not a workbook")
        self.assert_rejected("прочитать")
        self.write_source()
        for destination in (
            self.directory,
            self.directory / "result.csv",
            self.directory / "missing" / "result.xlsx",
        ):
            with self.subTest(destination=destination), self.assertRaises(RegistryError):
                enrich_registry(self.source, destination)

    def test_same_file_and_aliases_never_overwrite_source(self):
        self.write_source()
        before = self.source.read_bytes()
        for destination in (self.source, self.directory / "." / self.source.name):
            with (
                self.subTest(destination=destination),
                self.assertRaisesRegex(RegistryError, "исходн"),
            ):
                enrich_registry(self.source, destination)
        self.assertEqual(self.source.read_bytes(), before)

    def test_file_links_never_overwrite_source(self):
        self.write_source()
        before = self.source.read_bytes()
        for kind in ("symbolic", "hard"):
            with self.subTest(kind=kind):
                alias = self.directory / f"{kind}.xlsx"
                try:
                    if kind == "symbolic":
                        alias.symlink_to(self.source)
                    else:
                        os.link(self.source, alias)
                except OSError as error:
                    self.skipTest(f"Создание ссылки недоступно в этой ОС: {error}")
                with self.assertRaisesRegex(RegistryError, "исходн"):
                    enrich_registry(self.source, alias)
        self.assertEqual(self.source.read_bytes(), before)

    def test_cleanup_failure_is_reported_without_losing_previous_result(self):
        self.write_source()
        self.output.write_bytes(b"previous result")
        with patch("os.replace", side_effect=PermissionError("Выход заблокирован")):
            with patch.object(Path, "unlink", side_effect=PermissionError("Удаление запрещено")):
                with self.assertRaisesRegex(RegistryError, "Временный файл"):
                    enrich_registry(self.source, self.output)
        self.assertEqual(self.output.read_bytes(), b"previous result")

    def test_save_and_replace_failures_preserve_files_and_clean_temporary_file(self):
        self.write_source()
        before = self.source.read_bytes()
        # Имитируем отказ записи — чтобы проверить сохранность прежнего результата.
        for target in ("openpyxl.workbook.workbook.Workbook.save", "os.replace"):
            for old_result in (False, True):
                with self.subTest(target=target, old_result=old_result):
                    self.output.unlink(missing_ok=True)
                    if old_result:
                        self.output.write_bytes(b"previous result")
                    with patch(target, side_effect=PermissionError("Доступ запрещён")):
                        with self.assertRaisesRegex(RegistryError, "сохранить"):
                            enrich_registry(self.source, self.output)
                    self.assertEqual(self.source.read_bytes(), before)
                    if old_result:
                        self.assertEqual(self.output.read_bytes(), b"previous result")
                    else:
                        self.assertFalse(self.output.exists())
                    self.assertEqual(
                        set(self.directory.iterdir()),
                        {self.source, self.output} if old_result else {self.source},
                    )


class RegistryCommandTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="команда реестра ")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.script = ROOT / "process_registry.py"

    def run_command(self, *arguments):
        # Запускаем отдельный Python — чтобы проверить настоящую команду, а не только функцию.
        return subprocess.run(
            [sys.executable, "-B", str(self.script), *map(str, arguments)],
            cwd=self.directory,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=15,
            env={**os.environ, "PYTHONUTF8": "1"},
        )

    def test_cli_creates_result_with_unicode_paths(self):
        output = self.directory / "Результат с пробелом.xlsx"
        completed = self.run_command("--input", ROOT / "Реестр.xlsx", "--output", output)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("8", completed.stdout)
        self.assertIn(output.name, completed.stdout)
        with closing(load_workbook(output)) as book:
            self.assertEqual(book["Договоры"]["G2"].value, "REC-101")

    def test_cli_defaults_use_script_directory(self):
        # Запускаем копию из другой папки — чтобы проверить расположение входа и результата.
        task_directory = self.directory / "zadanie_1"
        task_directory.mkdir()
        for name in (
            "process_registry.py",
            "registry_excel.py",
            "registry_rules.py",
            "Реестр.xlsx",
        ):
            (task_directory / name).write_bytes((ROOT / name).read_bytes())
        self.script = task_directory / "process_registry.py"
        completed = self.run_command()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue((task_directory / "Результат.xlsx").is_file())
        self.assertFalse((self.directory / "Результат.xlsx").exists())

    def test_cli_reports_expected_failure_without_traceback(self):
        completed = self.run_command("--input", "Отсутствует.xlsx")
        self.assertEqual(completed.returncode, 1)
        self.assertIn("Входной файл", completed.stderr)
        self.assertNotIn("Traceback", completed.stderr)
        self.assertFalse((self.directory / "Результат.xlsx").exists())

    def test_cli_help_and_bad_arguments(self):
        help_result = self.run_command("--help")
        self.assertEqual(help_result.returncode, 0)
        self.assertIn("--input", help_result.stdout)
        self.assertIn("--output", help_result.stdout)
        self.assertEqual(self.run_command("--unknown").returncode, 2)
        self.assertEqual(list(self.directory.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
