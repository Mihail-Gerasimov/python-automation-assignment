// Назначение: настоящие файловые проверки очереди без БД, приложения и модельных запросов.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Queue } from '../scripts/queue.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'AGENTS.md'), 'Правила тестовой среды');
  writeFileSync(join(root, 'one.txt'), 'Исходный контракт');
  writeFileSync(join(root, 'two.txt'), 'Независимый контракт');
  return { root, queue: new Queue(root) };
}

const task = (id, overrides = {}) => ({
  id,
  batch: 'setup',
  step: '1',
  goal: 'Исправить согласованный локальный сценарий',
  mode: 'implement',
  change: 'text',
  signals: [],
  risks: [],
  files: ['one.txt'],
  checks: ['Прочитать итоговую правку'],
  dependsOn: [],
  access: 'workspace-write',
  ...overrides,
});

test('Повтор ID и выход за проект не создают вторую запись', (t) => {
  const { queue } = fixture(t);
  queue.enqueue(task('one'));
  assert.throws(() => queue.enqueue(task('one')));
  assert.throws(() => queue.enqueue(task('escape', { files: ['../foreign.txt'] })));
  assert.equal(queue.load().tasks.length, 1);
});

test('Одинаковые файлы сериализуются, независимые работают вместе, следующий шаг ждёт', (t) => {
  const { queue } = fixture(t);
  queue.enqueue(task('one'));
  queue.enqueue(task('same'));
  queue.enqueue(task('other', { files: ['two.txt'] }));
  queue.enqueue(task('future', { step: '2', files: ['future.txt'] }));
  assert.deepEqual(
    queue.ready(queue.load(), 'setup', 6).map((item) => item.id),
    ['one', 'other'],
  );
});

const astraTask = (id, overrides = {}) =>
  task(id, {
    mode: 'plan',
    change: 'none',
    access: 'read-only',
    profile: 'architect',
    risks: ['architecture'],
    reason: 'Выбрать один из двух вариантов общего контракта',
    escalation: {
      kind: 'architecture-decision',
      options: ['Общие версии', 'Локальные копии с историей'],
    },
    ...overrides,
  });

test('Основание Astra сохраняется, очередь ограничивает её одной между пакетами и оставляет слоты Sol', (t) => {
  const { queue } = fixture(t);
  const first = queue.enqueue(astraTask('astra-one'));
  queue.enqueue(astraTask('astra-two'));
  queue.enqueue(astraTask('astra-other-batch', { batch: 'other' }));
  queue.enqueue(task('sol', { files: ['three.txt'] }));
  assert.deepEqual(
    queue.ready(queue.load(), 'setup', 6).map((t) => t.id),
    ['astra-one', 'sol'],
  );
  const attempt = queue.begin('astra-one');
  assert.deepEqual(
    queue.ready(queue.load(), 'setup', 6).map((t) => t.id),
    ['sol'],
  );
  assert.deepEqual(queue.ready(queue.load(), 'other', 6), []);
  assert.throws(() => queue.begin('astra-other-batch'));
  queue.finish('astra-one', attempt.id, { status: 'completed' });
  assert.deepEqual(
    queue.ready(queue.load(), 'other', 6).map((t) => t.id),
    ['astra-other-batch'],
  );
  assert.deepEqual(first.escalation, astraTask('astra-one').escalation);
});

test('История прежней Astra читается, но старый маршрут pending не запускается по новой политике', (t) => {
  const { root, queue } = fixture(t);
  queue.enqueue(task('old', { risks: ['architecture'] }));
  const state = JSON.parse(readFileSync(queue.path, 'utf8'));
  state.tasks[0].route = {
    ...state.tasks[0].route,
    profile: 'architect',
    model: 'gpt-6-astra',
    effort: 'high',
  };
  writeFileSync(queue.path, JSON.stringify(state));
  assert.equal(queue.load().tasks[0].route.model, 'gpt-6-astra');
  assert.deepEqual(queue.ready(queue.load(), 'setup', 6), []);
  assert.throws(() => queue.begin('old'));
  assert.equal(JSON.parse(readFileSync(queue.path, 'utf8')).tasks[0].attempts.length, 0);
});

test('Снятый deep остаётся читаемой историей Astra/max без нового назначения и запуска', (t) => {
  const { queue } = fixture(t);
  queue.enqueue(astraTask('old-deep'));
  const state = JSON.parse(readFileSync(queue.path, 'utf8'));
  state.tasks[0].profile = 'deep';
  state.tasks[0].route.profile = 'deep';
  state.tasks[0].route.effort = 'max';
  state.tasks[0].escalation = {
    kind: 'user-request',
    requestedEffort: 'max',
    instruction: 'Используй Astra/max для этой старой задачи.',
  };
  writeFileSync(queue.path, JSON.stringify(state));
  const history = queue.load().tasks[0];
  assert.equal(history.profile, 'deep');
  assert.equal(history.route.effort, 'max');
  assert.deepEqual(queue.ready(queue.load(), 'setup', 6), []);
  assert.throws(() => queue.begin('old-deep'));
  assert.throws(
    () =>
      queue.enqueue({
        ...astraTask('new-deep'),
        profile: 'deep',
        escalation: state.tasks[0].escalation,
      }),
    /профиль|снят/,
  );
  assert.equal(queue.load().tasks[0].route.effort, 'max');
});

test('Прежний running deep занимает единственный слот Astra, а retry не возобновляет снятый профиль', (t) => {
  const { queue } = fixture(t);
  queue.enqueue(astraTask('old-running'));
  const attempt = queue.begin('old-running');
  queue.enqueue(astraTask('new-astra', { batch: 'next' }));
  queue.enqueue(task('new-sol', { batch: 'next', files: ['two.txt'] }));
  const state = JSON.parse(readFileSync(queue.path, 'utf8'));
  state.tasks[0].profile = 'deep';
  state.tasks[0].route.profile = 'deep';
  state.tasks[0].route.effort = 'max';
  writeFileSync(queue.path, JSON.stringify(state));
  assert.deepEqual(
    queue.ready(queue.load(), 'next', 6).map((item) => item.id),
    ['new-sol'],
  );
  queue.finish('old-running', attempt.id, { status: 'interrupted' });
  assert.throws(
    () => queue.retry('old-running', 'Прежний запуск остановлен, профиль снят'),
    /профиль|снят/,
  );
  assert.equal(queue.load().tasks[0].route.effort, 'max');
  assert.equal(queue.load().tasks[0].attempts.length, 1);
});

test('Новый максимальный effort проходит очередь и выдачу без замены профиля и потери причины', (t) => {
  const { queue } = fixture(t);
  const reason = 'Связанный сценарий двух writers требует проверки порядка блокировок';
  const created = queue.enqueue(
    task('sol-max', { profile: 'intensive', reason, risks: ['concurrency'] }),
  );
  assert.equal(created.route.effort, 'max');
  const attempt = queue.begin('sol-max');
  assert.equal(queue.load().tasks[0].reason, reason);
  assert.equal(queue.load().tasks[0].attempts.at(-1).id, attempt.id);
  assert.equal(queue.load().tasks[0].route.model, 'gpt-6.1-sol');
});

test('Алиасы одного файла не становятся независимыми writers', (t) => {
  const { root, queue } = fixture(t);
  linkSync(join(root, 'one.txt'), join(root, 'linked.txt'));
  queue.enqueue(task('original'));
  queue.enqueue(task('linked', { files: ['linked.txt'] }));
  queue.enqueue(task('case-alias', { files: ['ONE.txt'] }));
  assert.deepEqual(
    queue.ready(queue.load(), 'setup', 6).map((item) => item.id),
    ['original'],
  );
});

test('Поздняя задача не возвращает работу в пройденный шаг после запуска следующего', (t) => {
  const { queue } = fixture(t);
  queue.enqueue(task('one'));
  queue.enqueue(task('future', { step: '2', files: ['two.txt'] }));
  const first = queue.begin({ id: 'one' });
  queue.finish({ id: 'one' }, first.id, { status: 'completed' });
  queue.accept('one', 'Первый шаг проверен');
  queue.begin({ id: 'future' });
  assert.throws(() => queue.enqueue(task('late', { step: '1', files: ['new.txt'] })));
  assert.equal(queue.load().tasks.length, 2);
});

test('Повреждённая очередь не становится пустой успешной очередью', (t) => {
  const { queue } = fixture(t);
  mkdirSync(queue.dir, { recursive: true });
  writeFileSync(join(queue.dir, 'queue.json'), '{broken');
  assert.throws(() => queue.load());
  assert.throws(() => queue.save({ version: 1, root: queue.root, paused: false, tasks: [] }));
  assert.equal(readFileSync(queue.path, 'utf8'), '{broken');
});

test('Корень и версия проверяются, неудачная синхронная мутация сохраняет прежний файл', (t) => {
  const { root, queue } = fixture(t);
  assert.deepEqual(queue.load(), { version: 1, root: queue.root, paused: false, tasks: [] });
  queue.enqueue(task('one'));
  const previous = readFileSync(queue.path, 'utf8');
  assert.throws(() =>
    queue.mutate((state) => {
      state.paused = true;
      throw new Error('Прерванная операция');
    }),
  );
  assert.throws(() =>
    queue.mutate(async (state) => {
      state.paused = true;
    }),
  );
  assert.equal(readFileSync(queue.path, 'utf8'), previous);
  assert.deepEqual(readdirSync(queue.dir), ['queue.json']);
  for (const patch of [{ version: 2 }, { root: join(root, 'foreign') }]) {
    writeFileSync(queue.path, JSON.stringify({ ...JSON.parse(previous), ...patch }));
    assert.throws(() => queue.load());
  }
});

test('Живой lock не снимается другим владельцем, вложенные операции одного Queue допустимы', (t) => {
  const { root, queue } = fixture(t);
  const release = queue.acquire();
  try {
    queue.enqueue(task('one'));
    const other = new Queue(root);
    assert.throws(() => other.acquire());
    assert.throws(() => other.recover());
    assert.equal(queue.load().tasks.length, 1);
  } finally {
    release();
  }
  const otherRelease = new Queue(root).acquire();
  otherRelease();
});

test('Старый release не удаляет lock с другим nonce', (t) => {
  const { queue } = fixture(t);
  const release = queue.acquire();
  const ownerPath = join(queue.dir, 'queue.lock', 'owner.json');
  const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  writeFileSync(ownerPath, JSON.stringify({ ...owner, nonce: 'другой-владелец' }));
  assert.throws(release);
  assert.equal(JSON.parse(readFileSync(ownerPath, 'utf8')).nonce, 'другой-владелец');
});

test('Явное восстановление снимает мёртвый lock, running становится needs_review без повтора', (t) => {
  const { root, queue } = fixture(t);
  queue.enqueue(task('one'));
  queue.begin({ id: 'one' });
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { Queue } from ${JSON.stringify(new URL('../scripts/queue.mjs', import.meta.url).href)}; new Queue(${JSON.stringify(root)}).acquire();`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.throws(() => queue.acquire());
  queue.recover();
  const saved = queue.load().tasks[0];
  assert.equal(saved.status, 'needs_review');
  assert.equal(saved.attempts.length, 1);
  assert.deepEqual(queue.ready(queue.load(), 'setup', 6), []);
  assert.throws(() => queue.accept('one', 'Исход команды неизвестен'));
});

test('Только текущая завершённая попытка и актуальные файлы допускают приёмку', (t) => {
  const { root, queue } = fixture(t);
  queue.enqueue(task('one'));
  const attempt = queue.begin({ id: 'one' });
  assert.equal(queue.load().tasks[0].status, 'running');
  assert.throws(() => queue.finish({ id: 'one' }, 'старая-попытка', { status: 'completed' }));
  assert.throws(() => queue.accept('one', 'Проверено'));
  writeFileSync(join(root, 'one.txt'), 'Завершённая правка');
  const result = queue.finish({ id: 'one' }, attempt.id, { status: 'completed' });
  assert.equal(result.status, 'awaiting_review');
  assert.equal(queue.current(result), true);
  assert.throws(() => queue.finish(result, attempt.id, { status: 'completed' }));
  assert.throws(() => queue.accept('one', '  '));
  writeFileSync(join(root, 'one.txt'), 'Правка после проверки');
  assert.equal(queue.current(result), false);
  assert.throws(() => queue.accept('one', 'Проверен уже другой файл'));
  assert.equal(queue.load().tasks[0].status, 'needs_review');
});

test('Read-only поручение, изменившее объявленный файл, нельзя принять как успешное', (t) => {
  const { root, queue } = fixture(t);
  queue.enqueue(task('reader', { mode: 'inspect', change: 'none', access: 'read-only' }));
  const attempt = queue.begin('reader');
  writeFileSync(join(root, 'one.txt'), 'Нарушение ограничения только на чтение');
  const result = queue.finish('reader', attempt.id, { status: 'completed' });
  assert.equal(result.status, 'needs_review');
  assert.match(result.attempts.at(-1).scopeViolation, /Read-only/);
  assert.throws(() => queue.accept('reader', 'Самоотчёт исполнителя не заменяет проверку'));
});

test('Retry требует причины, обновляет инструкции и не обходит лимит попыток', (t) => {
  const { root, queue } = fixture(t);
  queue.enqueue(task('one'));
  const first = queue.begin({ id: 'one' });
  queue.finish({ id: 'one' }, first.id, { status: 'failed', error: 'Адресная ошибка' });
  const previous = queue.load().tasks[0];
  writeFileSync(join(root, 'AGENTS.md'), 'Изменённый согласованный контракт');
  assert.equal(queue.current(previous, queue.snapshot(previous)), false);
  assert.throws(() => queue.retry('one', ''));
  queue.retry('one', 'Причина устранена, новые инструкции прочитаны');
  const retried = queue.load().tasks[0];
  assert.equal(retried.status, 'pending');
  assert.notDeepEqual(retried.instructions, previous.instructions);
  const second = queue.begin(retried);
  assert.notEqual(second.id, first.id);
  assert.throws(() => queue.finish(retried, first.id, { status: 'completed' }));
  queue.finish(retried, second.id, { status: 'interrupted' });
  assert.throws(() => queue.retry('one', 'Ещё одна попытка'));
  assert.throws(() => queue.enqueue(task('unlimited', { maxAttempts: 4 })));
});

test('Writer удерживает файлы до приёмки, reviews разрешает только актуальное чтение своего writer', (t) => {
  const { root, queue } = fixture(t);
  queue.enqueue(task('writer'));
  queue.enqueue(task('reader', { mode: 'inspect', change: 'none', access: 'read-only' }));
  queue.enqueue(
    task('reviewer', { mode: 'review', change: 'none', access: 'read-only', reviews: 'writer' }),
  );
  queue.enqueue(task('future', { step: '2', files: ['two.txt'], dependsOn: ['writer'] }));
  const attempt = queue.begin({ id: 'writer' });
  assert.deepEqual(queue.ready(queue.load(), 'setup', 6), []);
  queue.finish({ id: 'writer' }, attempt.id, { status: 'completed' });
  assert.deepEqual(
    queue.ready(queue.load(), 'setup', 6).map((item) => item.id),
    ['reviewer'],
  );
  queue.accept('writer', 'Проверен итоговый файл writer');
  assert.deepEqual(
    queue.ready(queue.load(), 'setup', 6).map((item) => item.id),
    ['reader', 'reviewer'],
  );
  for (const id of ['reader', 'reviewer']) {
    const check = queue.begin({ id });
    queue.finish({ id }, check.id, { status: 'completed' });
    queue.accept(id, 'Подтверждено адресным просмотром');
  }
  writeFileSync(join(root, 'one.txt'), 'Вход зависимости изменён');
  assert.deepEqual(queue.ready(queue.load(), 'setup', 6), []);
});

test('Зависимости не пересекают batch, выбирается только указанный batch, read/read не конфликтует', (t) => {
  const { queue } = fixture(t);
  queue.enqueue(task('first', { mode: 'inspect', change: 'none', access: 'read-only' }));
  queue.enqueue(task('also-read', { mode: 'inspect', change: 'none', access: 'read-only' }));
  queue.enqueue(task('next', { batch: 'later', files: ['two.txt'] }));
  const reuse = queue.enqueue(
    task('reuse', {
      mode: 'inspect',
      change: 'none',
      access: 'read-only',
      reuseFrom: 'first',
      dependsOn: ['first'],
    }),
  );
  assert.equal(reuse.reuseFrom, 'first');
  assert.deepEqual(
    queue.ready(queue.load(), 'later', 6).map((item) => item.id),
    ['next'],
  );
  assert.deepEqual(
    queue.ready(queue.load(), 'setup', 6).map((item) => item.id),
    ['first', 'also-read'],
  );
  assert.throws(() =>
    queue.enqueue(task('foreign-dependency', { batch: 'later', dependsOn: ['first'] })),
  );
  assert.throws(() => queue.enqueue(task('missing', { dependsOn: ['unknown'] })));
  assert.throws(() =>
    queue.enqueue(task('bad-review', { reviews: 'first', mode: 'review', access: 'read-only' })),
  );
  queue.mutate((state) => {
    state.paused = true;
  });
  assert.deepEqual(queue.ready(queue.load(), 'setup', 6), []);
  assert.throws(() => queue.begin({ id: 'first' }));
});

test('Новая команда выбирает свой batch, но чужой writer продолжает удерживать конфликтующий файл', (t) => {
  const { queue } = fixture(t);
  queue.enqueue(task('old'));
  queue.enqueue(task('conflict', { batch: 'requested' }));
  queue.enqueue(task('independent', { batch: 'requested', files: ['two.txt'] }));
  assert.deepEqual(
    queue.ready(queue.load(), 'requested', 6).map((item) => item.id),
    ['conflict', 'independent'],
  );
  const old = queue.begin({ id: 'old' });
  assert.deepEqual(
    queue.ready(queue.load(), 'requested', 6).map((item) => item.id),
    ['independent'],
  );
  queue.finish({ id: 'old' }, old.id, { status: 'failed' });
  assert.deepEqual(
    queue.ready(queue.load(), 'requested', 6).map((item) => item.id),
    ['independent'],
  );
  assert.equal(queue.load().tasks[0].status, 'needs_review');
});

test('Точные пути не допускают каталог, symlink, инструкции, служебные файлы и секреты на запись', (t) => {
  const { root, queue } = fixture(t);
  mkdirSync(join(root, 'folder'));
  symlinkSync(join(root, 'folder'), join(root, 'alias'));
  for (const file of [
    'folder',
    'alias/new.txt',
    './one.txt',
    '../one.txt',
    '/tmp/outside.txt',
    '.codex/orchestration/queue.json',
    '.git/config',
    'AGENTS.md',
    '.agents/skills/tdd/SKILL.md',
    'nested/.env',
    'backups/database.sql',
  ]) {
    assert.throws(() => queue.enqueue(task('unsafe', { files: [file] })), file);
  }
  const created = queue.enqueue(task('new-file', { files: ['new.txt'] }));
  assert.deepEqual(queue.snapshot(created), { 'new.txt': null });
  const inspect = queue.enqueue(
    task('read-rules', {
      files: ['AGENTS.md'],
      mode: 'inspect',
      change: 'none',
      access: 'read-only',
    }),
  );
  assert.equal(inspect.route.profile, 'scan');
  assert.equal(typeof inspect.instructions[join(queue.root, 'AGENTS.md')], 'string');
});

test('Повреждённая структура и переполнение не заменяют сохранённую очередь', (t) => {
  const { queue } = fixture(t);
  queue.enqueue(task('one'));
  const state = queue.load();
  state.tasks = Array.from({ length: 128 }, (_, index) => ({
    ...state.tasks[0],
    id: `task-${index}`,
  }));
  queue.save(state);
  const previous = readFileSync(queue.path, 'utf8');
  assert.throws(() => queue.enqueue(task('overflow')));
  assert.equal(readFileSync(queue.path, 'utf8'), previous);
  assert.throws(() => queue.save({ ...state, tasks: {} }));
  assert.equal(readFileSync(queue.path, 'utf8'), previous);
  assert.equal(queue.load().tasks.length, 128);
});
