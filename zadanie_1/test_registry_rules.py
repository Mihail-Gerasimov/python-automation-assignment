"""Проверки статусов, неоднозначных карточек и причин результата по заданию 1."""

import unittest

from registry_rules import ServiceResponse, classify_response


class RegistryRulesTest(unittest.TestCase):
    def test_required_outcomes(self):
        # Проверяем разные ответы — чтобы не перепутать отсутствие карточки и ошибку сервиса.
        cases = [
            (ServiceResponse("Успешно", "REC-1"), "Найдено", "REC-1", "одна"),
            (ServiceResponse("Успешно"), "Не найдено", None, "без карточек"),
            (
                ServiceResponse("Успешно", "REC-1;REC-2"),
                "Нужна проверка",
                None,
                "2",
            ),
            (
                ServiceResponse("Ошибка", comment="Сервис недоступен"),
                "Ошибка проверки",
                None,
                "Сервис недоступен",
            ),
            (None, "Ошибка проверки", None, "отсутствует"),
        ]
        for response, status, card, reason in cases:
            with self.subTest(response=response):
                result = classify_response(response)
                self.assertEqual((result.status, result.card), (status, card))
                self.assertIn(reason, result.explanation)

    def test_service_error_wins_over_cards(self):
        result = classify_response(ServiceResponse("Ошибка", "REC-1;REC-2"))
        self.assertEqual((result.status, result.card), ("Ошибка проверки", None))
        self.assertIn("Ошибка сервиса", result.explanation)

    def test_card_spacing_and_empty_elements(self):
        for cards in (" REC-1 ", "; REC-1 ;; "):
            with self.subTest(cards=cards):
                result = classify_response(ServiceResponse("Успешно", cards))
                self.assertEqual((result.status, result.card), ("Найдено", "REC-1"))
        for cards in (None, "", " \t "):
            with self.subTest(cards=cards):
                self.assertEqual(
                    classify_response(ServiceResponse("Успешно", cards)).status, "Не найдено"
                )

    def test_duplicate_card_is_not_confirmed(self):
        # Передаём карточку дважды — чтобы дубли не превратились в подтверждённый результат.
        result = classify_response(ServiceResponse("Успешно", "REC-1;REC-1"))
        self.assertEqual((result.status, result.card), ("Нужна проверка", None))

    def test_invalid_response_is_not_a_missing_response(self):
        for status in (None, "", "Ожидание", "успешно"):
            with self.subTest(status=status), self.assertRaisesRegex(ValueError, "Ответ сервиса"):
                classify_response(ServiceResponse(status))

    def test_invalid_card_list_is_not_an_empty_success(self):
        for cards in ("; ;", 123, True):
            with self.subTest(cards=cards), self.assertRaisesRegex(ValueError, "Карточки"):
                classify_response(ServiceResponse("Успешно", cards))

    def test_error_reason_is_present_without_a_comment(self):
        for comment in (None, "", "  "):
            with self.subTest(comment=comment):
                result = classify_response(ServiceResponse("Ошибка", comment=comment))
                self.assertEqual(result.explanation, "Ошибка сервиса")

    def test_long_error_comment_stays_brief(self):
        result = classify_response(ServiceResponse("Ошибка", comment="Описание " * 5000))
        self.assertLess(len(result.explanation), 250)
        self.assertIn("Описание", result.explanation)


if __name__ == "__main__":
    unittest.main()
