"""Расчёт выполнения плана по отделам и по суммарным исходным значениям."""

import json


def _percentage(fact, plan):
    # Возвращаем None при нулевом плане — чтобы не показывать ложные 0%.
    if plan == 0:
        return None
    return round(fact / plan * 100, 1)


def calculate(rows):
    departments = []
    total_plan = 0
    total_fact = 0
    for row in rows:
        departments.append({**row, "percent": _percentage(row["fact"], row["plan"])})
        total_plan += row["plan"]
        # Включаем факт без плана — чтобы учесть всю выполненную работу.
        total_fact += row["fact"]
    # Считаем процент по суммам — чтобы не усреднять проценты разных по объёму отделов.
    return {"departments": departments, "total_percent": _percentage(total_fact, total_plan)}


if __name__ == "__main__":
    data = [
        {"department": "А", "plan": 100, "fact": 90},
        {"department": "Б", "plan": 900, "fact": 450},
        {"department": "В", "plan": 0, "fact": 20},
    ]
    print(json.dumps(calculate(data), ensure_ascii=False, indent=2))
