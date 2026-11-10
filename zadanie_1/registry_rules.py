"""Правила переноса ответа сервиса в результат проверки договора."""

from dataclasses import dataclass


@dataclass(frozen=True)
class ServiceResponse:
    status: str
    cards: str | None = None
    comment: str | None = None


@dataclass(frozen=True)
class CheckResult:
    status: str
    card: str | None
    explanation: str


class ResponseError(ValueError):
    """Некорректное поле ответа; имя поля помогает указать ячейку источника."""

    def __init__(self, field: str, message: str):
        self.field = field
        super().__init__(f"{field}: {message}")


def classify_response(response: ServiceResponse | None) -> CheckResult:
    if response is None:
        return CheckResult("Ошибка проверки", None, "Ответ сервиса отсутствует")

    # Отклоняем неизвестный статус — чтобы не принять его за успешную проверку.
    if response.status not in ("Успешно", "Ошибка"):
        raise ResponseError("Ответ сервиса", f"неизвестное значение {response.status!r}")

    # Сначала проверяем ошибку сервиса — чтобы карточки из сбойного ответа не попали в результат.
    if response.status == "Ошибка":
        explanation = "Ошибка сервиса"
        if response.comment is not None:
            if not isinstance(response.comment, str):
                raise ResponseError("Комментарий сервиса", "ожидается текст")
            if response.comment.strip():
                # Сокращаем длинный ответ — чтобы пояснение в Excel оставалось читаемым.
                explanation += f": {response.comment.strip()[:200]}"
        return CheckResult("Ошибка проверки", None, explanation)

    if response.cards is not None and not isinstance(response.cards, str):
        raise ResponseError("Карточки", "ожидается текст со списком через точку с запятой")
    text = (response.cards or "").strip()
    # Убираем пробелы и пустые элементы — чтобы корректно разобрать список карточек.
    cards = [part.strip() for part in text.split(";") if part.strip()]
    if text and not cards:
        raise ResponseError("Карточки", "список содержит только разделители")

    if not cards:
        return CheckResult("Не найдено", None, "Успешный ответ без карточек")
    # Сохраняем повторы карточек — чтобы не скрыть неоднозначный ответ сервиса.
    if len(cards) == 1:
        return CheckResult("Найдено", cards[0], "Получена одна карточка")
    return CheckResult(
        "Нужна проверка", None, f"Получено карточек: {len(cards)}. Требуется ручная проверка"
    )
