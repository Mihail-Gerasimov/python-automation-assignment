// Назначение: сквозной локальный цикл штатного агента и стоп без запуска моделей/приложения.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { main, runBatch } from '../scripts/cli.mjs';
import { Queue } from '../scripts/queue.mjs';
import { AppServer } from '../scripts/app-server.mjs';
import { config } from '../scripts/policy.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-cli-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.codex'));
  writeFileSync(
    join(root, '.codex/config.toml'),
    '[agents]\nenabled = true\nmax_concurrent_threads_per_session = 2\n',
  );
  writeFileSync(join(root, 'AGENTS.md'), 'Только тестовый проект');
  writeFileSync(join(root, 'menu.txt'), 'До изменения');
  const task = {
    id: 'menu',
    batch: 'local',
    step: '1',
    goal: 'Исправить подпись в согласованном файле',
    mode: 'implement',
    change: 'text',
    signals: [],
    risks: [],
    files: ['menu.txt'],
    checks: ['Проверить итоговый текст'],
    access: 'workspace-write',
  };
  return { root, task, queue: new Queue(root) };
}

test('Claim сохраняется; bind сверяет реальные параметры; finish не заменяет приёмку', async (t) => {
  const { root, task, queue } = fixture(t);
  await main(['enqueue', '--json', JSON.stringify(task)], root);
  const [claimed] = await main(['claim', '--batch', 'local', '--capacity', '1'], root);
  assert.equal(queue.load().tasks[0].status, 'running');
  assert.equal(claimed.status, 'running');
  const binding = {
    attemptId: claimed.attemptId,
    agentName: 'test-agent',
    model: claimed.route.model,
    effort: claimed.route.effort,
  };
  await assert.rejects(
    main(['bind', 'menu', '--json', JSON.stringify({ ...binding, effort: 'max' })], root),
  );
  await main(['bind', 'menu', '--json', JSON.stringify(binding)], root);
  await main(['bind', 'menu', '--json', JSON.stringify(binding)], root);
  await assert.rejects(
    main(
      ['bind', 'menu', '--json', JSON.stringify({ ...binding, agentName: 'replacement-agent' })],
      root,
    ),
  );
  writeFileSync(join(root, 'menu.txt'), 'После изменения');
  await main(
    [
      'finish',
      'menu',
      '--json',
      JSON.stringify({
        attemptId: claimed.attemptId,
        status: 'completed',
        summary: 'Текст проверен',
      }),
    ],
    root,
  );
  assert.equal(queue.load().tasks[0].status, 'awaiting_review');
  await main(['accept', 'menu', '--evidence', 'Итоговый текст прочитан на текущем файле'], root);
  assert.equal(queue.load().tasks[0].status, 'accepted');
});

test('Стоп записывается при занятом lock, а возобновление не повторяет неизвестный running', async (t) => {
  const { root, task, queue } = fixture(t);
  queue.enqueue(task);
  const release = queue.acquire();
  try {
    queue.begin(task);
    const result = await main(['stop'], root);
    assert.equal(result.stopRequested, true);
    assert.ok(JSON.parse(readFileSync(join(queue.dir, 'stop.json'), 'utf8')).requestedAt);
  } finally {
    release();
  }
  await assert.rejects(main(['resume'], root));
  await main(['recover'], root);
  assert.equal(queue.load().tasks[0].status, 'needs_review');
  await main(['resume'], root);
  assert.deepEqual(await main(['claim', '--batch', 'local', '--capacity', '1'], root), []);
});

test('Количество слотов задаётся явно и ограничивается конфигурацией проекта', async (t) => {
  const { root, task } = fixture(t);
  await main(['enqueue', '--json', JSON.stringify(task)], root);
  await assert.rejects(main(['claim', '--batch', 'local'], root));
  await assert.rejects(main(['claim', '--batch', 'local', '--capacity', '3'], root));
});

test('Подтверждённый отказ spawn закрывает только свою незапущенную попытку', async (t) => {
  const { root, task, queue } = fixture(t);
  queue.enqueue(task);
  queue.enqueue({ ...task, id: 'other', files: ['other.txt'] });
  const first = queue.begin(task);
  queue.begin('other');
  await main(
    [
      'abort-claim',
      'menu',
      '--json',
      JSON.stringify({
        attemptId: first.id,
        notStarted: true,
        reason: 'Spawn вернул явный отказ до создания агента; список запусков сверен',
      }),
    ],
    root,
  );
  assert.equal(queue.load().tasks[0].status, 'needs_review');
  assert.equal(queue.load().tasks[1].status, 'running');
});

// Подменяется только внешний модельный порт; очередь, попытки, события и ожидание настоящие.
class ModelPort extends EventEmitter {
  constructor(queue, scenario) {
    super();
    Object.assign(this, {
      queue,
      scenario,
      pending: new Map(),
      completed: new Map(),
      active: new Map(),
      messages: new Map(),
      turns: 0,
      stops: [],
    });
  }
  async initialize() {}
  async models() {
    return Object.values(config.profiles).map((profile) => ({
      model: profile.model,
      supportedReasoningEfforts: ['medium', 'high', 'xhigh', 'max'].map((reasoningEffort) => ({
        reasoningEffort,
      })),
    }));
  }
  receive(value) {
    AppServer.prototype.receive.call(this, value);
  }
  fail(error) {
    AppServer.prototype.fail.call(this, error);
  }
  waitForTurn(...args) {
    return AppServer.prototype.waitForTurn.apply(this, args);
  }
  async request(method, params) {
    if (method === 'skills/list')
      return {
        data: [
          {
            skills: Object.keys(this.queue.load().tasks[0].instructions)
              .filter((path) => basename(path) === 'SKILL.md')
              .map((path) => ({ name: basename(dirname(path)), path, enabled: true })),
          },
        ],
      };
    if (method === 'thread/start') return { thread: { id: 'thread-test' } };
    if (method === 'turn/start') {
      this.turns++;
      this.receive({
        method: 'turn/started',
        params: { threadId: params.threadId, turn: { id: 'turn-test' } },
      });
      if (this.scenario === 'lost-ack') throw new Error('Ответ turn/start потерян');
      if (this.scenario === 'signal-write-error') {
        mkdirSync(join(this.queue.dir, 'stop.json'));
        try {
          process.emit('SIGTERM');
        } catch (error) {
          this.signalHandlerError = error.message;
        }
      }
      if (this.scenario === 'stop-error') writeFileSync(join(this.queue.dir, 'stop.json'), '{}');
      else if (this.scenario !== 'signal-write-error')
        this.receive({
          method: 'turn/completed',
          params: { threadId: params.threadId, turn: { id: 'turn-test', status: 'completed' } },
        });
      return { turn: { id: 'turn-test' } };
    }
    throw new Error(`Непредусмотренный вызов ${method}`);
  }
  async stopThread(threadId, turnId) {
    this.stops.push({ threadId, turnId });
    if (this.scenario === 'stop-error') throw new Error('Остановка терминала не подтверждена');
    this.receive({
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status: 'interrupted' } },
    });
  }
  async close() {
    this.closed = true;
  }
}

test('Дополнительные effort доходят до штатной привязки и RPC без автоматического повышения или подмены', async (t) => {
  for (const [profile, effort] of [
    ['advanced', 'xhigh'],
    ['intensive', 'max'],
  ]) {
    const { root, task, queue } = fixture(t);
    const input = {
      ...task,
      profile,
      reason: 'Несколько связанных состояний требуют подробной проверки переходов',
    };
    await main(['enqueue', '--json', JSON.stringify(input)], root);
    const [claimed] = await main(['claim', '--batch', 'local', '--capacity', '1'], root);
    await main(
      [
        'bind',
        task.id,
        '--json',
        JSON.stringify({
          attemptId: claimed.attemptId,
          agentName: 'verified-effort-agent',
          model: 'gpt-6.1-sol',
          effort,
        }),
      ],
      root,
    );
    assert.equal(queue.load().tasks[0].attempts[0].native.effort, effort);

    const { queue: rpcQueue, task: rpcTask } = fixture(t);
    rpcQueue.enqueue({ ...rpcTask, profile, reason: input.reason });
    const client = new ModelPort(rpcQueue, 'complete');
    const request = client.request.bind(client);
    let received;
    client.request = async (method, params) => {
      if (method === 'turn/start') received = params;
      return request(method, params);
    };
    await runBatch(rpcQueue, 'local', 1, () => client);
    assert.equal(received.model, 'gpt-6.1-sol');
    assert.equal(received.effort, effort);
    assert.equal(rpcQueue.load().tasks[0].status, 'awaiting_review');
  }
});

test('Отсутствующий максимальный effort останавливает runner до создания потока и модельного turn', async (t) => {
  const { queue, task } = fixture(t);
  queue.enqueue({
    ...task,
    profile: 'intensive',
    reason: 'Нужен разбор связанного сложного перехода состояний',
  });
  const client = new ModelPort(queue, 'complete');
  client.models = async () => [
    { model: 'gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
  ];
  const request = client.request.bind(client);
  const started = [];
  client.request = async (method, params) => {
    if (method === 'thread/start' || method === 'turn/start') started.push(method);
    return request(method, params);
  };
  await assert.rejects(
    runBatch(queue, 'local', 1, () => client),
    /Недоступен/,
  );
  assert.deepEqual(started, []);
  assert.equal(client.turns, 0);
  assert.equal(queue.load().tasks[0].attempts.length, 0);
  assert.equal(queue.load().tasks[0].route.effort, 'max');
});

test('Runner сохраняет реальный turn ID до потерянного ack и не запускает вторую попытку', async (t) => {
  const { queue, task } = fixture(t);
  queue.enqueue(task);
  const client = new ModelPort(queue, 'lost-ack');
  await runBatch(queue, 'local', 1, () => client);
  const saved = queue.load().tasks[0];
  assert.equal(saved.status, 'needs_review');
  assert.equal(saved.attempts[0].turnId, 'turn-test');
  assert.equal(client.turns, 1);
  assert.deepEqual(client.stops[0], { threadId: 'thread-test', turnId: 'turn-test' });
  assert.ok(client.closed);
});

test(
  'Неподтверждённый стоп прерывает ожидание и оставляет needs_review, не ложный успех',
  { timeout: 3000 },
  async (t) => {
    const { queue, task } = fixture(t);
    queue.enqueue(task);
    const client = new ModelPort(queue, 'stop-error');
    const result = await runBatch(queue, 'local', 1, () => client);
    assert.equal(result.paused, true);
    assert.equal(queue.load().tasks[0].status, 'needs_review');
    assert.equal(client.turns, 1);
    assert.ok(client.closed);
  },
);

test(
  'Ошибка записи stop-маркера не выбрасывается из обработчика сигнала и не мешает cleanup',
  { timeout: 3000 },
  async (t) => {
    const { queue, task } = fixture(t);
    queue.enqueue(task);
    const client = new ModelPort(queue, 'signal-write-error');
    await runBatch(queue, 'local', 1, () => client);
    assert.equal(client.signalHandlerError, undefined);
    assert.equal(queue.load().tasks[0].status, 'needs_review');
    assert.ok(client.closed);
  },
);
