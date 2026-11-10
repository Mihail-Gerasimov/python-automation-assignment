// Назначение: адресные проверки риска, маршрутизации инструкций и явных настроек модели.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config, route } from '../scripts/policy.mjs';

const task = (overrides = {}) => ({
  id: 'menu',
  batch: 'setup',
  step: '1',
  goal: 'Исправить выбранный сценарий',
  mode: 'implement',
  change: 'behavior',
  signals: ['code'],
  risks: [],
  files: ['dist/assets/app.mjs'],
  checks: ['Адресная проверка поведения'],
  dependsOn: [],
  access: 'workspace-write',
  ...overrides,
});

test('Критичные риски повышают профиль, а ручное переопределение не снижает минимум', () => {
  for (const risk of [
    'permissions',
    'money',
    'migration',
    'concurrency',
    'cross-module',
    'architecture',
    'uncertainty',
  ]) {
    assert.equal(route(task({ risks: [risk] })).profile, 'critical');
    assert.equal(route(task({ risks: [risk] })).model, 'gpt-6.1-sol');
    assert.throws(() =>
      route(task({ risks: [risk], profile: 'scan', reason: 'Слишком маленькая правка' })),
    );
  }
  assert.throws(() => route(task({ profile: 'deep' })));
});

const architecture = {
  profile: 'architect',
  mode: 'plan',
  change: 'none',
  access: 'read-only',
  risks: ['architecture'],
  reason: 'Выбрать хранение версий общего направления для двух существующих writers',
  escalation: {
    kind: 'architecture-decision',
    options: ['Неизменяемые версии', 'Изменяемая запись с отдельной историей'],
  },
};

test('Astra решает отдельный вопрос; общая причина, обычная реализация и неизвестное основание её не включают', () => {
  assert.equal(route(task(architecture)).model, 'gpt-6-astra');
  assert.equal(route(task(architecture)).effort, 'high');
  assert.throws(
    () => route(task({ ...architecture, escalation: undefined })),
    /основан|escalation/,
  );
  assert.throws(
    () => route(task({ ...architecture, mode: 'implement', access: 'workspace-write' })),
    /чтен|read-only/,
  );
  assert.throws(
    () =>
      route(
        task({
          ...architecture,
          escalation: { kind: 'complicated', evidence: 'Очень сложная задача' },
        }),
      ),
    /основан/,
  );
  assert.throws(
    () =>
      route(
        task({
          ...architecture,
          escalation: { kind: 'architecture-decision', options: ['Единственное решение'] },
        }),
      ),
    /вариант/,
  );
  assert.throws(() => route(task({ ...architecture, mode: 'verify' })), /чтен|read-only/);
});

test('Неопределённость остаётся на Sol, Astra-разбор требует записанного результата предыдущей работы Sol', () => {
  const escalation = {
    ...architecture,
    mode: 'inspect',
    risks: ['uncertainty'],
    escalation: { kind: 'sol-blocked' },
  };
  assert.throws(() => route(task(escalation)), /Sol|результат/);
  const result = route(
    task({
      ...escalation,
      escalation: {
        kind: 'sol-blocked',
        evidence:
          'Sol/high локализовал конфликт lock order; два действующих writer требуют противоположный порядок. Факт в отчёте текущего шага.',
      },
    }),
  );
  assert.equal(result.profile, 'architect');
});

test('Astra ограничена high; прежний deep больше нельзя назначить даже со старым разрешением max', () => {
  assert.throws(
    () =>
      route(
        task({
          ...architecture,
          profile: 'deep',
          escalation: {
            kind: 'user-request',
            requestedEffort: 'max',
            instruction: 'Используй Astra/max для разбора этой миграции.',
          },
        }),
      ),
    /профиль|снят/,
  );
  assert.throws(
    () =>
      route(
        task({
          ...architecture,
          escalation: {
            kind: 'user-request',
            requestedEffort: 'max',
            instruction: 'Используй Astra/max для разбора этой миграции.',
          },
        }),
      ),
    /effort|high/,
  );
  assert.equal(route(task(architecture)).effort, 'high');
});

test('Усиленный поиск Luna сохраняет границы чтения и не заменяет рискованный Sol', () => {
  for (const [profile, effort] of [
    ['scan-xhigh', 'xhigh'],
    ['scan-max', 'max'],
  ]) {
    const input = task({
      mode: 'inspect',
      change: 'none',
      access: 'read-only',
      profile,
      reason: 'Нужно сопоставить несколько связанных маршрутов и составить карту их вызовов',
    });
    const result = route(input);
    assert.equal(result.model, 'gpt-6-luna');
    assert.equal(result.effort, effort);
    assert.throws(() => route({ ...input, risks: ['uncertainty'] }), /ниже|риск/);
    assert.throws(
      () => route({ ...input, mode: 'implement', access: 'workspace-write' }),
      /ниже|чтен/,
    );
    assert.throws(() => route({ ...input, reason: undefined }), /причин/);
  }
  assert.throws(
    () => route(task({ profile: 'scan-ultra', reason: 'Нужен глубокий поиск по коду' })),
    /профиль/,
  );
});

test('Sol получает xhigh и max для сложного поручения с причиной, но обычные риски не включают их автоматически', () => {
  for (const [profile, effort] of [
    ['advanced', 'xhigh'],
    ['intensive', 'max'],
  ]) {
    const input = task({
      profile,
      risks: ['concurrency'],
      reason: 'Нужно проследить взаимный порядок блокировок двух writers и доказать атомарность',
    });
    const result = route(input);
    assert.equal(result.model, 'gpt-6.1-sol');
    assert.equal(result.effort, effort);
    assert.throws(() => route({ ...input, reason: undefined }), /причин/);
  }
  assert.equal(
    route(task({ risks: ['concurrency', 'architecture', 'uncertainty'] })).effort,
    'high',
  );
});

test('Ultra не выдаётся leaf-помощнику и не создаёт вложенный пул под видом effort', () => {
  assert.equal(config.profiles.parallel.model, 'gpt-6.1-sol');
  assert.equal(config.profiles.parallel.effort, 'ultra');
  assert.equal(config.profiles.parallel.scope, 'coordinator');
  assert.throws(
    () =>
      route(
        task({
          profile: 'parallel',
          reason: 'Сложный блок можно разделить на несколько независимых направлений',
        }),
      ),
    /координатор|Ultra/,
  );
});

test('Планирование выбирает методы без упрощения кода; косметика не получает TDD', () => {
  assert.deepEqual(
    route(task({ mode: 'plan', signals: ['product', 'conversion', 'ui', 'behavior'] })).skills,
    ['orchestration', 'product-planning', 'product-marketing', 'visual-design', 'tdd'],
  );
  assert.deepEqual(route(task({ change: 'cosmetic', signals: ['ui'] })).skills, [
    'orchestration',
    'visual-design',
  ]);
  assert.ok(!route(task({ change: 'refactor' })).skills.includes('tdd'));
  assert.ok(route(task()).skills.includes('code-simplifier'));
});

test('Механический поиск получает явную модель и effort; неизвестные признаки отвергаются', () => {
  const result = route(task({ mode: 'inspect', change: 'none', signals: [], access: 'read-only' }));
  assert.equal(result.model, 'gpt-6-luna');
  assert.equal(result.effort, 'high');
  assert.throws(() => route(task({ risks: ['small'] })));
  assert.throws(() => route(task({ mode: 'review', access: 'workspace-write' })));
});
