import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./api.js";
import JSZip from "jszip";
import { normalizeQuestion } from "../src/agentQuestions.js";
import { structuredModel } from "./fixtures.js";

delete process.env.AUTH_USERS;

const q = (text: string, extra: Record<string, unknown> = {}) => ({ text, ...extra });

describe("хранилище вопросов к интервью и отчётов агентов", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let id: string;
  let code: string; // код операции по Соглашению
  beforeAll(async () => {
    app = await startApp();
    id = (await app.call("POST", "/sessions/blank", { meta: { processName: "Вопросы и отчёты" } })).body.id;
    await app.call("PUT", `/sessions/${id}/model`, structuredModel());
    code = (await app.call("GET", `/agent/sessions/${id}/model`)).body.codes.o2;
  });
  afterAll(() => app.close());

  it("нормализация для поиска повторов: регистр, ё, знаки и пробелы не важны", () => {
    expect(normalizeQuestion("  Кто  подписывает   Акт?! ")).toBe(normalizeQuestion("кто подписывает акт"));
    expect(normalizeQuestion("Ещё раз")).toBe(normalizeQuestion("еще раз"));
  });

  it("вопросы: сохраняются пакетом, функция — по коду или id, повторы не плодятся", async () => {
    expect(code).toMatch(/^B002\./);
    const r = await app.call("POST", `/agent/sessions/${id}/questions`, {
      agent: "интервьюер",
      questions: [
        q("Кто подписывает протокол интервью?", { addressee: "Специалист отдела", scope: code, reason: "нет владельца операции", priority: "critical" }),
        q("Сколько по времени занимает согласование?", { scope: "o2" }),
        q("Что происходит, если респондент не пришёл?"),
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.added).toHaveLength(3);
    expect(r.body.added[0]).toMatchObject({ scopeNodeId: "o2", priority: "critical", status: "open", agent: "интервьюер", addressee: "Специалист отдела" });
    expect(r.body.added[1].priority).toBe("important"); // по умолчанию
    expect(r.body.added[2].scopeNodeId).toBeNull();

    const again = await app.call("POST", `/agent/sessions/${id}/questions`, { agent: "интервьюер", questions: [q("кто подписывает протокол интервью"), q("Новый вопрос про сроки?")] });
    expect(again.body.added).toHaveLength(1);
    expect(again.body.duplicates).toEqual([{ id: r.body.added[0].id, text: "Кто подписывает протокол интервью?", status: "open" }]);

    // порядок: по важности, критичный первым
    const listed = (await app.call("GET", `/agent/sessions/${id}/questions`)).body;
    expect(listed).toHaveLength(4);
    expect(listed[0].priority).toBe("critical");
    expect((await app.call("GET", `/agent/sessions/${id}/questions?status=asked`)).body).toEqual([]);
    expect((await app.call("GET", `/agent/sessions/${id}/questions?status=что`)).status).toBe(400);
  });

  it("вопросы: пакет принимается целиком или не принимается; чужое и несуществующее отклоняется", async () => {
    const before = (await app.call("GET", `/sessions/${id}/agent-questions`)).body.length;
    const bad = await app.call("POST", `/agent/sessions/${id}/questions`, { agent: "интервьюер", questions: [q("Нормальный вопрос про сроки?"), q("Вопрос про нет-такой", { scope: "B999.99.99" })] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/B999\.99\.99/);
    expect((await app.call("GET", `/sessions/${id}/agent-questions`)).body).toHaveLength(before);
    expect((await app.call("POST", `/agent/sessions/${id}/questions`, { agent: "интервьюер", questions: [] })).status).toBe(400);
    expect((await app.call("POST", `/agent/sessions/${id}/questions`, { agent: "интервьюер", questions: [q("к")] })).status).toBe(400); // слишком короткий
    expect((await app.call("POST", "/agent/sessions/нет/questions", { agent: "x", questions: [q("Вопрос номер один?")] })).status).toBe(404);
    expect((await app.call("POST", `/agent/sessions/${id}/questions`, { agent: "интервьюер", questions: [q("Вопрос по заданию?")], task_id: "task_нет" })).status).toBe(404);
  });

  it("вопросы: не больше 10 ожидающих на одну функцию — остальное отложено", async () => {
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Лимит" } })).body.id;
    await app.call("PUT", `/sessions/${s}/model`, structuredModel());
    const questions = Array.from({ length: 12 }, (_, i) => q(`Вопрос номер ${i + 1} про сроки согласования?`, { scope: "o1" }));
    const r = await app.call("POST", `/agent/sessions/${s}/questions`, { agent: "интервьюер", questions });
    expect(r.status).toBe(201);
    expect(r.body.added).toHaveLength(10);
    expect(r.body.skipped).toHaveLength(2);
    expect(r.body.skipped[0].reason).toMatch(/отложите/);
  });

  it("вопросы: общий лимит ждущих (60) учитывает и сам пакет — его нельзя превысить одним вызовом", async () => {
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Общий лимит" } })).body.id;
    await app.call("PUT", `/sessions/${s}/model`, structuredModel());
    const fill = async (scope: string, n: number) => {
      const questions = Array.from({ length: n }, (_, i) => ({ text: `Вопрос ${scope} номер ${i + 1} про сроки?`, scope }));
      expect((await app.call("POST", `/agent/sessions/${s}/questions`, { agent: "интервьюер", questions })).body.added).toHaveLength(n);
    };
    for (const scope of ["o1", "o2", "o3", "s1", "s2"]) await fill(scope, 10);
    await fill("b0", 9); // 59 ждущих
    const batch = await app.call("POST", `/agent/sessions/${s}/questions`, { agent: "интервьюер", questions: ["b1", "b2", "b9"].map((scope) => ({ text: `Ещё вопрос ${scope} про сроки?`, scope })) });
    expect(batch.body.added).toHaveLength(1); // только до 60
    expect(batch.body.skipped).toHaveLength(2);
    expect(batch.body.skipped[0].reason).toMatch(/60 ждущих вопросов/);
    expect(((await app.call("GET", `/sessions/${s}/agent-questions`)).body as any[]).filter((q) => q.status === "open")).toHaveLength(60);
  });

  it("вопросы: аналитик отмечает заданный, отвеченный (с фрагментом) и снятый; ответ сохраняется только у отвеченного", async () => {
    const qid = (await app.call("GET", `/sessions/${id}/agent-questions`)).body.find((x: any) => x.text.startsWith("Что происходит"))!.id;
    expect((await app.call("POST", `/agent-questions/${qid}/status`, { status: "asked" })).body.status).toBe("asked");
    expect((await app.call("POST", `/agent-questions/${qid}/status`, { status: "answered", answer: "  Переносим на другой день  ", fragment_id: "нет-такого" })).status).toBe(400);
    const answered = await app.call("POST", `/agent-questions/${qid}/status`, { status: "answered", answer: "  Переносим на другой день  " });
    expect(answered.body).toMatchObject({ status: "answered", answer: "Переносим на другой день" });
    // вернули в работу — ответ не остаётся висеть
    expect(await app.call("POST", `/agent-questions/${qid}/status`, { status: "open", answer: "лишнее" })).toMatchObject({ body: { status: "open", answer: null, fragmentId: null } });
    expect((await app.call("POST", `/agent-questions/${qid}/status`, { status: "dismissed" })).body.status).toBe("dismissed");
    expect((await app.call("POST", `/agent-questions/${qid}/status`, { status: "что" })).status).toBe(400);
    expect((await app.call("POST", "/agent-questions/q_нет/status", { status: "asked" })).status).toBe(404);

    // снятый вопрос можно задать снова — он не считается повтором
    const re = await app.call("POST", `/agent/sessions/${id}/questions`, { agent: "интервьюер", questions: [q("Что происходит, если респондент не пришёл?")] });
    expect(re.body.added).toHaveLength(1);
    // агент видит статусы и ответы
    const answeredList = (await app.call("GET", `/agent/sessions/${id}/questions?status=dismissed`)).body;
    expect(answeredList.map((x: any) => x.id)).toEqual([qid]);
  });

  it("отчёты: сохраняются со структурой выводов, список без полного текста, статус меняет аналитик", async () => {
    const r = await app.call("POST", `/agent/sessions/${id}/reports`, {
      agent: "аналитик",
      kind: "analysis",
      title: "Анализ интервью",
      summary: "Основные потери — ожидание согласования",
      body: "# Подробно\n\nТекст отчёта",
      scope: code,
      findings: [{ what: "Ожидание согласования", where: code, basis: "time_waiting = 3 дня", impact: "high", confidence: "medium", recommendation: "Ввести срок" }],
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "new", kind: "analysis", scopeNodeId: "o2", agent: "аналитик" });
    expect(r.body.findings[0]).toMatchObject({ impact: "high", confidence: "medium" });

    const list = (await app.call("GET", `/agent/sessions/${id}/reports`)).body;
    expect(list).toHaveLength(1);
    expect(list[0].hasBody).toBe(true);
    expect(list[0].body).toBeUndefined();
    expect((await app.call("GET", `/agent/reports/${r.body.id}`)).body.body).toContain("Текст отчёта");

    expect((await app.call("POST", `/agent-reports/${r.body.id}/status`, { status: "read" })).body.status).toBe("read");
    expect((await app.call("GET", `/agent/sessions/${id}/reports?status=new`)).body).toEqual([]);
    expect((await app.call("POST", `/agent-reports/${r.body.id}/status`, { status: "что" })).status).toBe(400);
    expect((await app.call("POST", "/agent-reports/rep_нет/status", { status: "read" })).status).toBe(404);
  });

  it("отчёты: проверки формата и порядок списка — новые раньше прочитанных и архивных", async () => {
    const post = (b: Record<string, unknown>) => app.call("POST", `/agent/sessions/${id}/reports`, { agent: "нормоконтролёр", ...b });
    expect((await post({ title: "Пустой" })).status).toBe(400); // нет содержания
    expect((await post({ title: "Х", summary: "текст" })).status).toBe(400); // название короче 3 знаков
    expect((await post({ title: "Отчёт", summary: "текст", findings: [{ what: "что-то", impact: "огромное", confidence: "high" }] })).status).toBe(400);
    expect((await post({ title: "Отчёт", summary: "текст", scope: "B999.99.99" })).status).toBe(400);
    expect((await post({ title: "Отчёт", summary: "текст", task_id: "task_нет" })).status).toBe(404);

    const second = await post({ title: "Проверка модели", kind: "review", summary: "Замечаний нет" });
    expect(second.status).toBe(201);
    const titles = (await app.call("GET", `/sessions/${id}/agent-reports`)).body.map((x: any) => x.title);
    expect(titles).toEqual(["Проверка модели", "Анализ интервью"]); // первый уже прочитан
  });

  it("запись по закрытому заданию отклоняется, по открытому — привязывается", async () => {
    const t = (await app.call("POST", `/sessions/${id}/tasks`, { text: "Подготовь вопросы", agent: "интервьюер" })).body;
    const ok = await app.call("POST", `/agent/sessions/${id}/questions`, { agent: "интервьюер", questions: [q("Вопрос по заданию аналитика?")], task_id: t.id });
    expect(ok.body.added[0].taskId).toBe(t.id);
    await app.call("POST", `/agent/tasks/${t.id}/complete`, { note: "готово" });
    expect((await app.call("POST", `/agent/sessions/${id}/questions`, { agent: "интервьюер", questions: [q("Ещё один вопрос после закрытия?")], task_id: t.id })).status).toBe(409);
    expect((await app.call("POST", `/agent/sessions/${id}/reports`, { agent: "аналитик", title: "Поздний отчёт", summary: "текст", task_id: t.id })).status).toBe(409);
  });

  /** Текст документа Word: содержимое document.xml без разметки. */
  const docxText = async (res: { body: unknown }) => {
    const zip = await JSZip.loadAsync(res.body as Buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    return xml.replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  };

  it("лист вопросов в Word: по функциям, ждущие и заданные, без отвеченных и снятых", async () => {
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Экспорт вопросов" } })).body.id;
    await app.call("PUT", `/sessions/${s}/model`, structuredModel());
    const fnCode = (await app.call("GET", `/agent/sessions/${s}/model`)).body.codes.o2;
    const post = async (text: string, extra: Record<string, unknown> = {}) => (await app.call("POST", `/agent/sessions/${s}/questions`, { agent: "интервьюер", questions: [{ text, ...extra }] })).body.added[0].id as string;
    await post("Кто подписывает акт приёмки?", { scope: fnCode, addressee: "Начальник склада", reason: "нет владельца", priority: "critical" });
    await post("Какие системы использует отдел?");
    const answered = await post("Вопрос с ответом про сроки?");
    const dismissed = await post("Снятый вопрос про бюджет?");
    await app.call("POST", `/agent-questions/${answered}/status`, { status: "answered", answer: "Три дня" });
    await app.call("POST", `/agent-questions/${dismissed}/status`, { status: "dismissed" });
    const res = await app.raw(`/sessions/${s}/agent-questions/export.docx`);
    expect(res.status).toBe(200);
    const text = await docxText(res);
    expect(text).toContain("ЛИСТ ВОПРОСОВ К ИНТЕРВЬЮ");
    expect(text).toContain("Экспорт вопросов");
    expect(text).toContain("Кто подписывает акт приёмки?");
    expect(text).toContain("Начальник склада");
    expect(text).toContain(`${fnCode} «Проведение первичного интервью»`);
    expect(text).toContain("Процесс в целом");
    expect(text.indexOf("Процесс в целом")).toBeLessThan(text.indexOf(fnCode)); // процесс в целом — первым
    expect(text).not.toContain("Вопрос с ответом");
    expect(text).not.toContain("Снятый вопрос");
    expect((await app.raw("/sessions/нет/agent-questions/export.docx")).status).toBe(404);
  });

  it("отчёт в Word: сводка, таблица выводов, полный текст с заголовками и списками", async () => {
    const created = await app.call("POST", `/agent/sessions/${id}/reports`, {
      agent: "аналитик",
      title: "Отчёт для Word",
      summary: "Главное: ожидание подписи",
      scope: code,
      findings: [{ what: "Ожидание подписи", where: code, basis: "time_waiting = 3 дня", impact: "high", confidence: "medium", recommendation: "Ввести срок" }],
      body: "# Раздел\nПервый абзац\n- пункт списка\n## Подраздел",
    });
    const res = await app.raw(`/agent-reports/${created.body.id}/export.docx`);
    expect(res.status).toBe(200);
    const text = await docxText(res);
    for (const part of ["Отчёт для Word", "Главное: ожидание подписи", "Выводы", "высокое", "Ожидание подписи", "time_waiting = 3 дня", "среднее", "Ввести срок", "Раздел", "Первый абзац", "пункт списка", "Подраздел"]) expect(text, part).toContain(part);
    expect(text).not.toContain("# Раздел"); // разметка превращена в заголовки
    expect((await app.raw("/agent-reports/rep_нет/export.docx")).status).toBe(404);
  });

  it("отчёт помечается устаревшим, когда изменилось содержание модели, но не раскладка диаграмм", async () => {
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Устаревание отчёта" } })).body.id;
    await app.call("PUT", `/sessions/${s}/model`, structuredModel());
    const created = (await app.call("POST", `/agent/sessions/${s}/reports`, { agent: "аналитик", title: "Отчёт по версии", summary: "Состояние на сейчас" })).body;
    const stale = async () => (await app.call("GET", `/agent/sessions/${s}/reports`)).body[0].stale as boolean;
    expect(await stale()).toBe(false);
    // раскладка и ручные маршруты — не содержание
    const moved = structuredModel();
    moved.nodes[0].layout = { x: 999, y: 111 };
    expect((await app.call("PUT", `/sessions/${s}/model`, moved)).status).toBe(200);
    expect(await stale()).toBe(false);
    // название шага — содержание
    const renamed = structuredModel();
    renamed.nodes.find((n) => n.id === "b1")!.name = "Открыть реестр процессов";
    expect((await app.call("PUT", `/sessions/${s}/model`, renamed)).status).toBe(200);
    expect(await stale()).toBe(true);
    expect((await app.call("GET", `/sessions/${s}/agent-reports`)).body[0].stale).toBe(true);
    expect((await app.call("GET", `/agent/reports/${created.id}`)).body.stale).toBe(true);
  });

  it("аналитик получает уведомления о предложениях, вопросах и отчётах; повтор вопроса уведомления не создаёт", async () => {
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Уведомления агентов" } })).body.id;
    await app.call("PUT", `/sessions/${s}/model`, structuredModel());
    const notes = async () => ((await app.call("GET", `/notifications?session_id=${s}`)).body as { message: string; recipient_kind: string; diff_link: string; is_read: number }[]).map((n) => n);
    expect(await notes()).toEqual([]);
    await app.call("POST", `/agent/sessions/${s}/questions`, { agent: "интервьюер", questions: [{ text: "Кто утверждает реестр?" }, { text: "Как часто он обновляется?" }] });
    await app.call("POST", `/agent/sessions/${s}/questions`, { agent: "интервьюер", questions: [{ text: "кто утверждает реестр" }] }); // повтор
    await app.call("POST", `/agent/sessions/${s}/reports`, { agent: "аналитик", title: "Узкие места", summary: "Текст" });
    await app.call("POST", `/agent/sessions/${s}/proposals`, { agent: "моделист", title: "Цель процесса", ops: [{ op: "set_process", patch: { goal: "Цель" } }] });
    const rows = await notes();
    expect(rows).toHaveLength(3);
    const texts = rows.map((r) => r.message).join("\n");
    expect(texts).toContain("сохранил вопросов к интервью: 2");
    expect(texts).toContain("прислал отчёт «Узкие места»");
    expect(texts).toContain("предложил правки: Цель процесса");
    expect(rows.every((r) => r.recipient_kind === "analyst" && r.is_read === 0 && r.diff_link === `/s/${s}?tab=studio`)).toBe(true);
  });

  it("удаление сессии убирает её вопросы и отчёты", async () => {
    const s = (await app.call("POST", "/sessions/blank", { meta: { processName: "Удаляемая" } })).body.id;
    await app.call("POST", `/agent/sessions/${s}/questions`, { agent: "интервьюер", questions: [q("Вопрос удаляемой сессии?")] });
    await app.call("POST", `/agent/sessions/${s}/reports`, { agent: "аналитик", title: "Отчёт удаляемой", summary: "текст" });
    expect((await app.call("DELETE", `/sessions/${s}`)).status).toBeLessThan(300);
    const { db } = await import("../src/db.js");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM agent_questions WHERE session_id = ?`).get(s)).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM agent_reports WHERE session_id = ?`).get(s)).toEqual({ n: 0 });
  });
});


describe("отпечаток модели для пометки устаревшего отчёта", () => {
  it("номер версии процесса, раскладка и маршруты в отпечаток не входят, а поле version у других записей — входит", async () => {
    const { modelFingerprint } = await import("../src/agentReports.js");
    const base = { process: { name: "П", version: "0.1" }, nodes: [{ id: "n1", name: "Шаг", layout: { x: 1, y: 2 }, version: "a" }], flows: [{ id: "f", route: { channel: 5 } }] };
    const same = { process: { name: "П", version: "0.9" }, nodes: [{ id: "n1", name: "Шаг", layout: { x: 500, y: 600 }, version: "a" }], flows: [{ id: "f", route: { channel: 99 } }] };
    expect(modelFingerprint(same)).toBe(modelFingerprint(base));
    const changed = { ...same, nodes: [{ id: "n1", name: "Шаг", layout: { x: 1, y: 2 }, version: "b" }] };
    expect(modelFingerprint(changed)).not.toBe(modelFingerprint(base));
    expect(modelFingerprint(null)).toBeNull();
  });
});