// Назначение: контракт RPC, запрет тихой подмены модели и корреляция событий без модельной генерации.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AppServer, turnParams, validateModel } from '../scripts/app-server.mjs';

const task = {
  id: 'sample',
  goal: 'Проверить сценарий',
  access: 'read-only',
  route: {
    model: 'gpt-6.1-sol',
    effort: 'high',
    skills: ['orchestration'],
  },
  instructions: { '/skills/orchestration/SKILL.md': 'hash' },
};

test('В RPC явно передаются модель, effort, скилл и ограниченный режим; недоступность не снижает профиль', () => {
  const reason = 'Прямой выбор модели заказчиком для этого поручения';
  const escalation = {
    kind: 'user-request',
    instruction: 'Используй Astra/high для этой проверки.',
  };
  const params = turnParams({ ...task, reason, escalation }, 'thread-one');
  const contract = JSON.parse(params.input[0].text.split('\n').at(-1));
  assert.equal(contract.reason, reason);
  assert.deepEqual(contract.escalation, escalation);
  assert.equal(params.model, 'gpt-6.1-sol');
  assert.equal(params.effort, 'high');
  assert.equal(params.sandboxPolicy.type, 'readOnly');
  assert.deepEqual(
    params.input.find((input) => input.type === 'skill'),
    {
      type: 'skill',
      name: 'orchestration',
      path: '/skills/orchestration/SKILL.md',
    },
  );
  assert.throws(() => validateModel([], task.route));
  assert.throws(() =>
    validateModel(
      [{ model: 'gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }],
      task.route,
    ),
  );
});

test('Максимальные effort Luna и Sol явно передаются в RPC и проверяются по возможностям модели', () => {
  for (const model of ['gpt-6-luna', 'gpt-6.1-sol']) {
    const profile = { model, effort: 'max', skills: ['orchestration'] };
    validateModel([{ model, supportedReasoningEfforts: [{ reasoningEffort: 'max' }] }], profile);
    const params = turnParams({ ...task, route: profile }, 'thread-max');
    assert.equal(params.model, model);
    assert.equal(params.effort, 'max');
    assert.throws(
      () =>
        validateModel(
          [{ model, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }],
          profile,
        ),
      /Недоступен/,
    );
  }
});

test('Раннее событие завершения не теряется; транспорт передаёт параметры реальному JSON-RPC порту', async () => {
  const server = `
    const rl = require('node:readline').createInterface({input:process.stdin});
    rl.on('line', line => {
      const msg = JSON.parse(line); if(!msg.id)return;
      if(msg.method==='turn/start') {
        process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:msg.params.threadId,turn:{id:'turn-one',status:'completed'}}})+'\\n');
        process.stdout.write(JSON.stringify({id:msg.id,result:{turn:{id:'turn-one'},received:msg.params}})+'\\n');
      } else process.stdout.write(JSON.stringify({id:msg.id,result:{}})+'\\n');
    });
  `;
  const client = new AppServer({
    cwd: process.cwd(),
    command: process.execPath,
    args: ['-e', server],
  });
  try {
    await client.initialize();
    const result = await client.request('turn/start', turnParams(task, 'thread-one'));
    assert.equal(result.received.model, task.route.model);
    assert.equal(result.received.effort, task.route.effort);
    assert.equal(
      (await client.waitForTurn('thread-one', result.turn.id, 1000)).status,
      'completed',
    );
  } finally {
    await client.close();
  }
});

test('Отсутствующий CLI возвращает отказ и закрывается без зависшего процесса', async () => {
  const client = new AppServer({
    cwd: process.cwd(),
    command: '/missing-orchestration-test/codex',
  });
  try {
    await assert.rejects(client.initialize(), /ENOENT/);
  } finally {
    await client.close();
  }
});
