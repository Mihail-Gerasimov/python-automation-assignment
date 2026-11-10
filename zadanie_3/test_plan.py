"""Проверки процентов, нулевого плана и сохранности исходных данных."""

import unittest

from plan import calculate


class CalculateTest(unittest.TestCase):
    def setUp(self):
        self.rows = [
            {"department": "А", "plan": 100, "fact": 90},
            {"department": "Б", "plan": 900, "fact": 450},
            {"department": "В", "plan": 0, "fact": 20},
        ]

    def test_number_of_departments(self):
        self.assertEqual(len(calculate(self.rows)["departments"]), 3)

    def test_percentages_and_total_from_task(self):
        # Копируем входные строки — чтобы заметить, если расчёт изменит исходные данные.
        original_rows = [row.copy() for row in self.rows]

        # Проверяем числа и исходные данные — чтобы число отделов не скрывало ошибку расчёта.
        result = calculate(self.rows)

        self.assertEqual(
            result,
            {
                "departments": [
                    {**original_rows[0], "percent": 90.0},
                    {**original_rows[1], "percent": 50.0},
                    {**original_rows[2], "percent": None},
                ],
                "total_percent": 56.0,
            },
        )
        self.assertEqual(self.rows, original_rows)

    def test_zero_total_plan_and_empty_input(self):
        # Перебираем пустой и нулевой план — чтобы получать None, а не ложные 0%.
        for facts in ([], [0], [20], [0, 20]):
            with self.subTest(facts=facts):
                rows = [
                    {"department": str(index), "plan": 0, "fact": fact}
                    for index, fact in enumerate(facts)
                ]
                self.assertEqual(
                    calculate(rows),
                    {
                        "departments": [{**row, "percent": None} for row in rows],
                        "total_percent": None,
                    },
                )

    def test_rounding_and_zero_fact(self):
        # Берём дробные проценты — чтобы заметить округление до сложения исходных сумм.
        cases = [
            (
                "round_after_summing",
                [
                    {"department": "А", "plan": 3, "fact": 1},
                    {"department": "Б", "plan": 3, "fact": 1},
                    {"department": "В", "plan": 3, "fact": 4},
                ],
                [33.3, 33.3, 133.3],
                66.7,
            ),
            (
                "zero_fact_with_positive_plan",
                [{"department": "А", "plan": 10, "fact": 0}],
                [0.0],
                0.0,
            ),
        ]
        for name, rows, percentages, total in cases:
            with self.subTest(name=name):
                result = calculate(rows)
                self.assertEqual([row["percent"] for row in result["departments"]], percentages)
                self.assertEqual(result["total_percent"], total)


if __name__ == "__main__":
    unittest.main()
