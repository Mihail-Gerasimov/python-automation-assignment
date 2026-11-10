// Назначение: единый вход диспетчера, штатных агентов и альтернативного Codex App Server.
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Queue, writeAtomic } from './queue.mjs';
import { config, route } from './policy.mjs';
import { AppServer, turnParams, validateModel } from './app-server.mjs';

function argument(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
function jsonArgument(args) {
  const input = argument(args, '--json');
  if (!input) throw new Error('Нужен --json с контрактом/результатом');
  return JSON.parse(input);
}
function findTask(state, id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) throw new Error('Поручение не найдено');
  return task;
}

// Лимит проекта не доказывает реальную ёмкость клиента: координатор передаёт свободные слоты.
function capacityOf(args, root) {
  const capacity = Number(argument(args, '--capacity'));
  const text = readFileSync(join(root, '.codex/config.toml'), 'utf8');
  const section = text.match(/^\[agents\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] ?? '';
  const maximum = Number(
    section.match(/^\s*max_concurrent_threads_per_session\s*=\s*(\d+)/m)?.[1] ?? 1,
  );
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > maximum)
    throw new Error('Нужна подтверждённая --capacity в пределах проектного максимума');
  return capacity;
}

function summary(state) {
  return {
    paused: state.paused,
    tasks: state.tasks.map((task) => ({
      id: task.id,
      batch: task.batch,
      step: task.step,
      status: task.status,
      model: task.route.model,
      effort: task.route.effort,
      attempt: task.attempts.at(-1),
    })),
  };
}

async function doctor(root) {
  const temporary = mkdtempSync(join(tmpdir(), 'orchestration-doctor-'));
  const client = new AppServer({ cwd: temporary });
  try {
    await client.initialize();
    const models = await client.models();
    const catalogue = await client.request('skills/list', { cwds: [root], forceReload: true });
    const profiles = Object.fromEntries(
      Object.entries(config.profiles).map(([name, profile]) => {
        try {
          validateModel(models, profile);
          return [name, 'available'];
        } catch {
          return [name, 'unavailable'];
        }
      }),
    );
    return {
      profiles,
      skills: catalogue.data.flatMap((item) =>
        item.skills
          .filter((skill) => skill.name in config.skills)
          .map((skill) => ({ name: skill.name, enabled: skill.enabled })),
      ),
      modelTurnsStarted: 0,
    };
  } finally {
    await client.close();
    rmSync(temporary, { recursive: true, force: true });
  }
}

// Сохраняем попытку до запуска, а thread/turn — сразу после получения; неизвестный исход не повторяем.
export async function runBatch(
  queue,
  batch,
  capacity,
  createClient = (options) => new AppServer(options),
) {
  const release = queue.acquire();
  let client;
  const active = new Map();
  const stopFile = join(queue.dir, 'stop.json');
  let stopping = false;
  let stopPersistenceError;
  const requestStop = () => {
    stopping = true;
    try {
      writeAtomic(stopFile, { requestedAt: new Date().toISOString() });
    } catch (error) {
      stopPersistenceError = error.message;
    }
  };
  const interrupt = async () => {
    if (!stopping && !existsSync(stopFile)) return;
    stopping = true;
    try {
      queue.mutate((state) => {
        state.paused = true;
      });
    } catch (error) {
      stopPersistenceError = error.message;
    }
    await Promise.all(
      [...active.values()].map(async (entry) => {
        if (!entry.threadId || entry.stopping) return;
        entry.stopping = true;
        try {
          await client.stopThread(entry.threadId, entry.turnId);
        } catch (error) {
          entry.stopError = error.message;
          client.fail(
            new Error('Стоп не подтверждён; ожидания прерваны, результат требует сверки'),
          );
        }
      }),
    );
  };
  const control = setInterval(() => {
    interrupt().catch(requestStop);
  }, 300);
  process.on('SIGTERM', requestStop);
  process.on('SIGINT', requestStop);
  try {
    const initial = queue.load();
    if (initial.paused || existsSync(stopFile))
      throw new Error('Очередь на стопе; нужна новая команда resume');
    if (initial.tasks.some((task) => task.status === 'running'))
      throw new Error('Есть незавершённый запуск; сначала сверка/recover');
    if (!batch)
      throw new Error('Нужен --batch текущего поручения, весь архив автоматически не запускается');
    client = createClient({ cwd: queue.root });
    client.on('notification', (message) => {
      if (message.method !== 'turn/started') return;
      for (const [id, entry] of active)
        if (entry.threadId === message.params.threadId) {
          entry.turnId = message.params.turn.id;
          queue.mutate((state) => {
            const attempt = findTask(state, id).attempts.at(-1);
            if (attempt.id !== entry.attemptId) throw new Error('Событие другой попытки');
            attempt.turnId = entry.turnId;
          });
        }
    });
    await client.initialize();
    const models = await client.models();
    const catalogue = await client.request('skills/list', {
      cwds: [queue.root],
      forceReload: true,
    });
    for (const task of initial.tasks.filter(
      (task) => task.batch === batch && task.status === 'pending',
    )) {
      validateModel(models, task.route);
      for (const name of task.route.skills)
        if (
          !catalogue.data.some((item) =>
            item.skills.some(
              (skill) =>
                skill.name === name && skill.enabled && task.instructions[realpathSync(skill.path)],
            ),
          )
        )
          throw new Error(`Обязательный скилл ${name} недоступен в Codex`);
    }
    while (!stopping) {
      const ready = queue.ready(queue.load(), batch, capacity - active.size);
      for (const task of ready) {
        const attempt = queue.begin(task);
        const entry = { attemptId: attempt.id };
        active.set(task.id, entry);
        entry.promise = (async () => {
          try {
            let thread;
            if (task.reuseFrom) {
              const source = findTask(queue.load(), task.reuseFrom);
              if (
                task.mode === 'review' ||
                source.status !== 'accepted' ||
                source.batch !== task.batch ||
                source.mode !== task.mode ||
                source.access !== task.access ||
                JSON.stringify(source.files) !== JSON.stringify(task.files) ||
                JSON.stringify(source.instructions) !== JSON.stringify(task.instructions) ||
                !queue.current(source) ||
                !source.attempts.at(-1)?.threadId
              )
                throw new Error('Поток не совместим с новым поручением');
              thread = (
                await client.request('thread/resume', {
                  threadId: source.attempts.at(-1).threadId,
                  model: task.route.model,
                })
              ).thread;
            } else {
              thread = (
                await client.request('thread/start', {
                  cwd: queue.root,
                  model: task.route.model,
                  sandbox: task.access,
                  approvalPolicy: 'never',
                  config: { 'agents.enabled': false },
                  developerInstructions:
                    'ORCHESTRATION_WORKER: только назначенный контракт; не запускай подагентов, очередь, production, Git, фоновые процессы и операции с рабочими БД/данными/стендом. Права не расширять.',
                })
              ).thread;
            }
            entry.threadId = thread.id;
            queue.mutate((state) => {
              findTask(state, task.id).attempts.at(-1).threadId = thread.id;
            });
            if (stopping) throw new Error('Стоп до запуска модельного поручения');
            const turn = (await client.request('turn/start', turnParams(task, thread.id))).turn;
            entry.turnId = turn.id;
            queue.mutate((state) => {
              findTask(state, task.id).attempts.at(-1).turnId = turn.id;
            });
            const result = await client.waitForTurn(thread.id, turn.id);
            await client.stopThread(thread.id, turn.id);
            queue.finish(task, attempt.id, {
              status: stopping ? 'interrupted' : result.status,
              summary: result.summary,
            });
          } catch (error) {
            if (entry.threadId) {
              try {
                await client.stopThread(entry.threadId, entry.turnId);
              } catch (stopError) {
                entry.stopError = stopError.message;
              }
            }
            queue.finish(task, attempt.id, {
              status: 'unknown',
              summary: error.message,
              stopError: entry.stopError ?? null,
            });
          }
        })().finally(() => active.delete(task.id));
      }
      if (!active.size) break;
      await Promise.race([...active.values()].map((entry) => entry.promise));
    }
    await interrupt();
    await Promise.all([...active.values()].map((entry) => entry.promise));
    return {
      ...summary(queue.load()),
      warnings: stopPersistenceError
        ? [`Не удалось полностью сохранить стоп: ${stopPersistenceError}`]
        : [],
    };
  } catch (error) {
    if (active.size) {
      requestStop();
      await interrupt();
      await Promise.allSettled([...active.values()].map((entry) => entry.promise));
    }
    throw error;
  } finally {
    clearInterval(control);
    process.off('SIGTERM', requestStop);
    process.off('SIGINT', requestStop);
    try {
      await client?.close();
    } finally {
      release();
    }
  }
}

export async function main(args = process.argv.slice(2), root = process.cwd()) {
  const [command, id] = args;
  const queue = new Queue(root);
  switch (command) {
    case 'route':
      return route(jsonArgument(args));
    case 'doctor':
      return doctor(queue.root);
    case 'status':
      return summary(queue.load());
    case 'enqueue':
      return queue.enqueue(jsonArgument(args));
    case 'run':
      return runBatch(queue, argument(args, '--batch'), capacityOf(args, queue.root));
    case 'claim': {
      const release = queue.acquire();
      try {
        const ready = queue.ready(
          queue.load(),
          argument(args, '--batch'),
          capacityOf(args, queue.root),
        );
        return ready.map((task) => {
          const attempt = queue.begin(task);
          return { ...findTask(queue.load(), task.id), attemptId: attempt.id };
        });
      } finally {
        release();
      }
    }
    case 'bind':
      return queue.mutate((state) => {
        const task = findTask(state, id);
        const value = jsonArgument(args);
        const attempt = task.attempts.at(-1);
        if (
          task.status !== 'running' ||
          attempt.id !== value.attemptId ||
          attempt.threadId ||
          value.model !== task.route.model ||
          value.effort !== task.route.effort ||
          !value.agentName
        )
          throw new Error('Не совпадают попытка или фактические параметры агента');
        const binding = { agentName: value.agentName, model: value.model, effort: value.effort };
        if (attempt.native && JSON.stringify(attempt.native) !== JSON.stringify(binding))
          throw new Error('У попытки уже есть другой исполнитель');
        attempt.native = binding;
      });
    case 'abort-claim': {
      const value = jsonArgument(args);
      const task = findTask(queue.load(), id);
      const attempt = task.attempts.at(-1);
      if (
        task.status !== 'running' ||
        attempt?.id !== value.attemptId ||
        attempt.native ||
        attempt.threadId ||
        value.notStarted !== true ||
        typeof value.reason !== 'string' ||
        value.reason.trim().length < 10
      )
        throw new Error(
          'Нужно подтвердить адресный отказ ДО запуска, без привязанного исполнителя',
        );
      return queue.finish(task, value.attemptId, { status: 'not_started', summary: value.reason });
    }
    case 'finish': {
      const value = jsonArgument(args);
      const task = findTask(queue.load(), id);
      if (!task.attempts.at(-1)?.native) throw new Error('Сначала bind реального штатного агента');
      if (!['completed', 'failed', 'interrupted', 'unknown'].includes(value.status))
        throw new Error('Неверный исход');
      return queue.finish(task, value.attemptId, {
        status: value.status,
        summary: String(value.summary ?? '').slice(-8000),
      });
    }
    case 'accept':
      return queue.accept(id, argument(args, '--evidence'));
    case 'retry':
      return queue.retry(id, argument(args, '--reason'));
    case 'recover':
      queue.recover();
      return summary(queue.load());
    case 'resume':
      return queue.mutate((state) => {
        if (state.tasks.some((task) => task.status === 'running'))
          throw new Error('Сначала сверить прежние запуски');
        state.paused = false;
        rmSync(join(queue.dir, 'stop.json'), { force: true });
      });
    case 'stop': {
      queue.location(true);
      writeAtomic(join(queue.dir, 'stop.json'), { requestedAt: new Date().toISOString() });
      const state = queue.load();
      if (!existsSync(queue.lockPath))
        queue.mutate((current) => {
          current.paused = true;
        });
      return {
        stopRequested: true,
        nativeAgentsToInterrupt: state.tasks
          .filter((task) => task.status === 'running')
          .flatMap((task) => task.attempts.at(-1)?.native?.agentName ?? []),
        note: 'Проверь фактическую остановку агентов/команд; маркер не является подтверждением',
      };
    }
    default:
      throw new Error(
        'Команды: route, doctor, status, enqueue, claim, bind, abort-claim, finish, run, accept, retry, recover, stop, resume',
      );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
    .then((result) => console.log(JSON.stringify(result ?? { ok: true }, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
