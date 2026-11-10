# Источники Visual Design

Один подключаемый скилл. Авторские материалы не устанавливаются отдельными скиллами.

## Anthropic — творческая основа

- [anthropics/skills](https://github.com/anthropics/skills/tree/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/frontend-design),
  commit `dbd4588f9e1033efb41dad4bef2f7947c8993d44`.
- `skills/frontend-design/SKILL.md` → раздел «Основа Anthropic» в [SKILL.md](./SKILL.md).
  Содержание раздела сохранено: заменены frontmatter и заголовок; выше добавлен рабочий контракт.
- [Лицензия Apache-2.0](./LICENSES/Apache-2.0.txt) скопирована из исходного `LICENSE.txt`.

## Jakub Krehel — прикладные справочники

- [jakubkrehel/skills](https://github.com/jakubkrehel/skills/tree/4c66b1fa86e9ab70187b43d7da9b6fdb29f2ef63/skills),
  commit `4c66b1fa86e9ab70187b43d7da9b6fdb29f2ef63`.
- `skills/better-layout/` → [references/layout/](./references/layout/index.md).
- `skills/better-typography/` → [references/typography/](./references/typography/index.md).
- `skills/better-ui/` → [references/ui-polish/](./references/ui-polish/index.md).
- Основные `SKILL.md` переименованы в `index.md`, их frontmatter снят;
  тела и остальные Markdown-ресурсы сохранены, относительные ссылки не менялись.
  Авторские `agents/` не подключаются.
- [Лицензия MIT](./LICENSES/MIT.txt), copyright © 2026 Jakub Krehel.

## Адаптация

Рабочий контракт в основном скилле задаёт приоритет брифа, контекста текущего проекта,
границы редизайна, совместимость с фазами и адресные проверки. Он не превращает
авторские эвристики в неизменяемые стандарты и не требует других скиллов или сервисов.

`references/design-handoff.md` — локальная инструкция для работы с присланными макетами.
Проектные факты хранятся вне универсального скилла; в текущем проекте на них ссылается AGENTS.md.
Обновления upstream — явные, с проверкой адаптации, лицензий и внутренних ссылок.
