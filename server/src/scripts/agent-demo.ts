import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAgentServer, httpApi } from "../mcp/server.js";

/**
 * Имитатор агента: `npm run agent:demo -w server -- <id сессии>`. Проходит тем же путём, что Cline (инструменты MCP-сервера),
 * и отправляет аналитику несколько демонстрационных предложений: удачные, одно «неудачное» (его приложение отклонит с
 * понятной причиной) и задание. Так можно прорепетировать работу со вкладкой «Предложения агентов» до подключения Cline.
 * Названия предложений начинаются с «Демо:» — их можно смело отклонять. Заодно сохраняет демо-вопросы и демо-отчёт.
 */
const sessionId = process.argv[2];
if (!sessionId) {
  console.error("Укажите id сессии: npm run agent:demo -w server -- <id>. Список сессий: npm run agent:check -w server (или инструмент list_sessions).");
  process.exit(1);
}

const url = process.env.PM_API_URL ?? "http://127.0.0.1:8787";
const server = createAgentServer(httpApi(url, process.env.PM_AGENT_TOKEN ?? ""));
const client = new Client({ name: "agent-demo", version: "1" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), client.connect(b)]);

const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
};
const show = (title: string, r: { text: string; isError: boolean }) => console.log(`\n${r.isError ? "✗" : "✓"} ${title}\n${r.text.replace(/^/gm, "    ")}`);

const model = await call("get_model", { session_id: sessionId, view: "full" });
if (model.isError) {
  console.error(model.text);
  process.exit(1);
}
const data = JSON.parse(model.text).model as { nodes: { id: string; type: string; name: string; bpmn_scope?: string | null; idef0_parent?: string | null }[]; roles: { id: string }[] };
const fn = data.nodes.find((n) => (n.type === "task" || n.type === "subprocess") && !n.bpmn_scope);
if (!fn) {
  console.error("В модели нет функций: добавьте в студии хотя бы одну задачу.");
  process.exit(1);
}

show(
  "1. Правка названия (применимое предложение)",
  await call("propose_patch", {
    session_id: sessionId,
    agent: "нормоконтролёр",
    title: `Демо: уточнить название «${fn.name}»`,
    rationale: "Демонстрация: название блока должно быть инфинитивом или отглагольным существительным.",
    ops: [{ op: "update", collection: "nodes", id: fn.id, patch: { name: `${fn.name} (демо)` } }],
  })
);

show(
  "2. Новая должность и назначение (несколько операций в одном предложении)",
  await call("propose_patch", {
    session_id: sessionId,
    agent: "моделист",
    title: "Демо: добавить контролёра и назначить его на функцию",
    rationale: "Демонстрация ролевой модели: должность появляется в справочнике и назначается контролёром функции.",
    ops: [
      { op: "add", collection: "roles", value: { id: "r_demo_ctrl", name: "Контролёр (демо)" } },
      { op: "set_assignments", node_id: fn.id, items: [{ role_id: "r_demo_ctrl", kind: "controller", functions: ["Проверяет результат"] }] },
    ],
  })
);

show(
  "3. Предложение со ссылкой на несуществующую должность (приложение должно отклонить и объяснить)",
  await call("propose_patch", {
    session_id: sessionId,
    agent: "моделист",
    title: "Демо: шаг с неверной ссылкой",
    ops: [{ op: "add", collection: "nodes", value: { id: "n_demo_bad", type: "task", name: "Проверить заявку", role_id: "нет-такой-должности" } }],
  })
);

const tasks = await call("get_tasks", { session_id: sessionId });
show("4. Ожидающие задания аналитика (поставьте задание на вкладке «Задания агенту» и запустите имитатор снова)", tasks);
const open = /task_\w+/.exec(tasks.text)?.[0];
if (open) {
  show("   Взял задание в работу", await call("take_task", { task_id: open, agent: "моделист" }));
  show(
    "   Предложение по заданию",
    await call("propose_patch", {
      session_id: sessionId,
      agent: "моделист",
      title: "Демо: ответ на задание",
      task_id: open,
      ops: [{ op: "set_process", patch: { goal: "Демонстрационная цель процесса" } }],
    })
  );
  show("   Завершил задание", await call("complete_task", { task_id: open, note: "Демонстрация: предложена цель процесса; проверьте формулировку." }));
}

show(
  "5. Вопросы к интервью (вкладка «Вопросы»)",
  await call("add_questions", {
    session_id: sessionId,
    agent: "интервьюер",
    questions: [
      { text: `Демо: кто принимает решение по функции «${fn.name}»?`, addressee: "Владелец функции", reason: "Демонстрация: у функции не названо ответственное лицо", priority: "critical" },
      { text: `Демо: что происходит, если «${fn.name}» не выполнена в срок?`, priority: "important" },
    ],
  })
);

show(
  "6. Отчёт аналитика (вкладка «Отчёты»)",
  await call("add_report", {
    session_id: sessionId,
    agent: "аналитик",
    title: "Демо: выводы по процессу",
    summary: "Демонстрация: так выглядит отчёт с выводами и полным текстом.",
    findings: [{ what: `Демо: у функции «${fn.name}» нет данных о длительности`, where: fn.id, basis: "поле duration не заполнено", impact: "medium", confidence: "high", recommendation: "Спросить на следующем интервью" }],
    body: "# Демо-отчёт\n\nЭто демонстрационный отчёт: его можно прочитать и убрать в архив.",
  })
);

console.log(`\nГотово. Откройте студию → «Предложения агентов», «Вопросы», «Отчёты». Подключение адрес: ${url}`);
await client.close();
process.exit(0);
