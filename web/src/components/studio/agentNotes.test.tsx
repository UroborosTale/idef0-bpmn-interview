import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type AgentQuestionRow, type AgentReportRow } from "../../api/client";
import { session, structuredModel } from "../../test/fixtures";
import QuestionsPanel, { interviewSheet } from "./QuestionsPanel";
import ReportsPanel from "./ReportsPanel";
import Studio from "./Studio";

const question = (extra: Partial<AgentQuestionRow> = {}): AgentQuestionRow => ({
  id: "q_1",
  sessionId: "s1",
  text: "Кто подписывает протокол интервью?",
  addressee: "Начальник отдела",
  scopeNodeId: "o2",
  reason: "у операции нет владельца",
  priority: "critical",
  status: "open",
  answer: null,
  fragmentId: null,
  agent: "интервьюер",
  taskId: null,
  handoffTaskId: null,
  createdAt: "2026-10-08T10:00:00.000Z",
  ...extra,
});

const report = (extra: Partial<AgentReportRow> = {}): AgentReportRow => ({
  id: "rep_1",
  sessionId: "s1",
  agent: "аналитик",
  kind: "analysis",
  title: "Узкие места реестра",
  summary: "Основное время уходит на ожидание подписи",
  body: "Подробный текст отчёта",
  findings: [{ what: "Ожидание подписи", where: "B002.01.01", basis: "time_waiting = 3 дня", impact: "high", confidence: "medium", recommendation: "Ввести срок" }],
  scopeNodeId: "o1",
  taskId: null,
  status: "new",
  createdAt: "2026-10-08T10:00:00.000Z",
  ...extra,
});

const labelOf = (id: string) => `B002.01.02 «${id}»`;

afterEach(() => vi.restoreAllMocks());

describe("вопросы к интервью: вкладка", () => {
  const panel = (questions: AgentQuestionRow[]) => {
    const onStatus = vi.fn();
    render(<QuestionsPanel questions={questions} labelOf={labelOf} processName="Управление процессами" onStatus={onStatus} />);
    return onStatus;
  };

  it("пусто — подсказка, откуда берутся вопросы; копировать нечего", () => {
    panel([]);
    expect(screen.getByText(/Их готовит агент-интервьюер/)).toBeTruthy();
    expect((screen.getByText("Копировать для интервью") as HTMLButtonElement).disabled).toBe(true);
  });

  it("карточка: важность, функция, адресат, зачем; закрытые скрыты, пока не включён флажок", () => {
    panel([question(), question({ id: "q_2", text: "Что с просрочкой?", status: "answered", answer: "Эскалация", fragmentId: "f3" }), question({ id: "q_3", text: "Лишнее?", status: "dismissed" })]);
    expect(screen.getByText("Кто подписывает протокол интервью?")).toBeTruthy();
    expect(document.querySelector(".question-prio-critical")!.textContent).toBe("критично");
    expect(screen.getByText(/спросить: Начальник отдела/)).toBeTruthy();
    expect(screen.getByText("Зачем: у операции нет владельца")).toBeTruthy();
    expect(screen.queryByText("Что с просрочкой?")).toBeNull();
    fireEvent.click(screen.getByLabelText(/с отвеченными и снятыми \(2\)/));
    expect(screen.getByText("Что с просрочкой?")).toBeTruthy();
    expect(screen.getByText("Ответ (фрагмент f3): Эскалация")).toBeTruthy();
    expect(screen.getByText("Лишнее?")).toBeTruthy();
  });

  it("действия аналитика: задан, снять, ответ с текстом, возврат закрытого в список", () => {
    const onStatus = panel([question()]);
    fireEvent.click(screen.getByText("Задан"));
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ id: "q_1" }), "asked");
    fireEvent.click(screen.getByText("Снять"));
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ id: "q_1" }), "dismissed");
    fireEvent.click(screen.getByText("Получен ответ"));
    fireEvent.change(screen.getByPlaceholderText(/Ответ респондента/), { target: { value: "  Директор  " } });
    fireEvent.click(screen.getByText("Ответ получен"));
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ id: "q_1" }), "answered", "Директор");
    expect(screen.queryByPlaceholderText(/Ответ респондента/)).toBeNull();
  });

  it("вопрос, заданный интервьюером в ходе интервью, подписан его логином", () => {
    panel([question({ agent: "user:ivanov", status: "answered", answer: "Секретарь", fragmentId: "f4" })]);
    fireEvent.click(screen.getByLabelText(/с отвеченными и снятыми/));
    expect(screen.getByText(/задан интервьюером \(ivanov\)/)).toBeTruthy();
    expect(screen.getByText("Ответ (фрагмент f4): Секретарь")).toBeTruthy();
  });

  it("передача ответов моделисту: кнопка со счётчиком, переданные не считаются, в карточке видно задание", () => {
    const onHandOff = vi.fn();
    render(
      <QuestionsPanel
        questions={[question({ id: "q_a", status: "answered", answer: "Директор" }), question({ id: "q_b", status: "answered", handoffTaskId: "task_x1" }), question({ id: "q_c" })]}
        labelOf={labelOf}
        processName="П"
        onStatus={vi.fn()}
        onHandOff={onHandOff}
      />
    );
    fireEvent.click(screen.getByText("Передать ответы моделисту (1)"));
    expect(onHandOff).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText(/с отвеченными и снятыми/));
    expect(screen.getByText("Передано моделисту: задание task_x1")).toBeTruthy();
  });

  it("передавать нечего — кнопка неактивна", () => {
    render(<QuestionsPanel questions={[question()]} labelOf={labelOf} processName="П" onStatus={vi.fn()} onHandOff={vi.fn()} />);
    expect((screen.getByText("Передать ответы моделисту (0)") as HTMLButtonElement).disabled).toBe(true);
  });

  it("возврат: снятый вопрос возвращается в список ожидающих", () => {
    const onStatus = panel([question({ status: "dismissed" })]);
    fireEvent.click(screen.getByLabelText(/с отвеченными и снятыми/));
    fireEvent.click(screen.getByText("Вернуть в список"));
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ id: "q_1" }), "open");
  });

  it("лист для интервью: по функциям, с адресатами; отвеченные и снятые не попадают", () => {
    const sheet = interviewSheet(
      [
        question(),
        question({ id: "q_2", text: "Что с просрочкой?", priority: "important", addressee: null, reason: null }),
        question({ id: "q_3", text: "Общий вопрос о процессе?", scopeNodeId: null, priority: "desirable" }),
        question({ id: "q_4", text: "Уже отвечен?", status: "answered" }),
      ],
      labelOf,
      "Управление процессами"
    );
    expect(sheet).toBe(
      [
        "Вопросы к интервью: Управление процессами",
        "",
        "B002.01.02 «o2»",
        "1. [критично] Кто подписывает протокол интервью? — спросить: Начальник отдела (зачем: у операции нет владельца)",
        "2. [важно] Что с просрочкой?",
        "",
        "Процесс в целом",
        "3. [желательно] Общий вопрос о процессе? — спросить: Начальник отдела (зачем: у операции нет владельца)",
      ].join("\n")
    );
  });
});

describe("отчёты агентов: вкладка", () => {
  const panel = (reports: AgentReportRow[]) => {
    const onStatus = vi.fn();
    render(<ReportsPanel reports={reports} labelOf={labelOf} onStatus={onStatus} />);
    return onStatus;
  };

  it("пусто — подсказка; архивные скрыты, пока не включён флажок", () => {
    panel([]);
    expect(screen.getByText(/Их присылает агент-аналитик/)).toBeTruthy();
  });

  it("новый отчёт: краткое содержание видно сразу, выводы и текст — по щелчку, который отмечает отчёт прочитанным", () => {
    const onStatus = panel([report()]);
    expect(screen.getByText("Основное время уходит на ожидание подписи")).toBeTruthy();
    expect(screen.queryByText("Подробный текст отчёта")).toBeNull();
    fireEvent.click(screen.getByText("Узкие места реестра"));
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ id: "rep_1" }), "read");
    expect(screen.getByText("Подробный текст отчёта")).toBeTruthy();
    const cells = [...document.querySelectorAll(".report-findings tbody td")].map((c) => c.textContent);
    expect(cells).toEqual(["высокое", "Ожидание подписи", "B002.01.01", "time_waiting = 3 дня", "среднее", "Ввести срок"]);
    expect(screen.getByText(/Относится к: B002\.01\.02/)).toBeTruthy();
    // повторный щелчок сворачивает
    fireEvent.click(screen.getByText("Узкие места реестра"));
    expect(screen.queryByText("Подробный текст отчёта")).toBeNull();
  });

  it("вывод отчёта: код функции — ссылка на неё в студии; «Поручить моделисту» передаёт вывод", () => {
    const onSelectFn = vi.fn();
    const onAssign = vi.fn();
    render(<ReportsPanel reports={[report()]} labelOf={labelOf} onStatus={vi.fn()} nodeByCode={(c) => (c === "B002.01.01" ? "o1" : null)} onSelectFn={onSelectFn} onAssign={onAssign} />);
    fireEvent.click(screen.getByText("Узкие места реестра"));
    fireEvent.click(screen.getByTitle("Показать в студии"));
    expect(onSelectFn).toHaveBeenCalledWith("o1");
    fireEvent.click(screen.getByText("Поручить моделисту"));
    expect(onAssign).toHaveBeenCalledWith(expect.objectContaining({ id: "rep_1" }), expect.objectContaining({ what: "Ожидание подписи" }));
  });

  it("код, которого нет в модели, остаётся обычным текстом", () => {
    render(<ReportsPanel reports={[report()]} labelOf={labelOf} onStatus={vi.fn()} nodeByCode={() => null} onSelectFn={vi.fn()} />);
    fireEvent.click(screen.getByText("Узкие места реестра"));
    expect(screen.queryByTitle("Показать в студии")).toBeNull();
    expect(screen.getByText("B002.01.01")).toBeTruthy();
  });

  it("прочитанный отчёт при открытии не меняет статус; в архив и обратно", () => {
    const onStatus = panel([report({ status: "read" }), report({ id: "rep_2", title: "Старый отчёт", status: "archived" })]);
    fireEvent.click(screen.getByText("Узкие места реестра"));
    expect(onStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("В архив"));
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ id: "rep_1" }), "archived");
    expect(screen.queryByText("Старый отчёт")).toBeNull();
    fireEvent.click(screen.getByLabelText(/с архивом \(1\)/));
    fireEvent.click(screen.getByText("Вернуть из архива"));
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ id: "rep_2" }), "read");
  });
});

describe("студия: вопросы и отчёты", () => {
  const open = (questions: AgentQuestionRow[], reports: AgentReportRow[]) => {
    vi.spyOn(api, "listProposals").mockResolvedValue([]);
    vi.spyOn(api, "listTasks").mockResolvedValue([]);
    vi.spyOn(api, "listQuestions").mockResolvedValue(questions);
    vi.spyOn(api, "listReports").mockResolvedValue(reports);
    const setQ = vi.spyOn(api, "setQuestionStatus").mockResolvedValue(question({ status: "asked" }));
    const setR = vi.spyOn(api, "setReportStatus").mockResolvedValue(report({ status: "read" }));
    render(<Studio session={session(structuredModel())} busy={false} onSave={vi.fn(async () => true)} />);
    const tab = (name: string) => [...document.querySelectorAll(".problems-head button")].find((b) => b.textContent?.startsWith(name)) as HTMLElement;
    return { setQ, setR, tab };
  };

  it("счётчики на вкладках: ждущие вопросы и новые отчёты; без записей — спокойные", async () => {
    const { tab } = open([question(), question({ id: "q_2", status: "dismissed" })], [report(), report({ id: "rep_2", status: "read" })]);
    await act(async () => {});
    expect(tab("Вопросы").querySelector(".pill-count")!.textContent).toBe("1");
    expect(tab("Вопросы").querySelector(".pill-count")!.className).toContain("warn");
    expect(tab("Отчёты").querySelector(".pill-count")!.textContent).toBe("1");
  });

  it("решение аналитика уходит на сервер и список обновляется", async () => {
    const { tab, setQ, setR } = open([question()], [report()]);
    await act(async () => {});
    fireEvent.click(tab("Вопросы"));
    fireEvent.click(await screen.findByText("Задан"));
    await waitFor(() => expect(setQ).toHaveBeenCalledWith("q_1", { status: "asked" }));
    fireEvent.click(tab("Отчёты"));
    fireEvent.click(await screen.findByText("Узкие места реестра"));
    await waitFor(() => expect(setR).toHaveBeenCalledWith("rep_1", "read"));
  });

  it("студия: передача ответов и поручение по выводу создают задания моделисту и открывают вкладку заданий", async () => {
    vi.spyOn(api, "listProposals").mockResolvedValue([]);
    vi.spyOn(api, "listTasks").mockResolvedValue([]);
    vi.spyOn(api, "listQuestions").mockResolvedValue([question({ status: "answered", answer: "Директор", fragmentId: "f3" })]);
    vi.spyOn(api, "listReports").mockResolvedValue([report({ findings: [{ what: "Ожидание подписи", where: "B002.01.01", basis: "time_waiting = 3 дня", impact: "high", confidence: "medium", recommendation: "Ввести срок" }] })]);
    const hand = vi.spyOn(api, "handOffAnswers").mockResolvedValue({ task: {} as never, count: 1 });
    const create = vi.spyOn(api, "createTask").mockResolvedValue({} as never);
    render(<Studio session={session(structuredModel())} busy={false} onSave={vi.fn(async () => true)} />);
    await act(async () => {});
    const tab = (name: string) => [...document.querySelectorAll(".problems-head button")].find((b) => b.textContent?.startsWith(name)) as HTMLElement;
    fireEvent.click(tab("Вопросы"));
    fireEvent.click(await screen.findByText("Передать ответы моделисту (1)"));
    await waitFor(() => expect(hand).toHaveBeenCalledWith("sess_test"));
    await waitFor(() => expect(tab("Задания агенту").className).toContain("active"));
    fireEvent.click(tab("Отчёты"));
    fireEvent.click(await screen.findByText("Узкие места реестра"));
    fireEvent.click(await screen.findByText("Поручить моделисту"));
    await waitFor(() => expect(create).toHaveBeenCalled());
    const [sid, body] = create.mock.calls[0];
    expect(sid).toBe("sess_test");
    expect(body.agent).toBe("моделист");
    expect(body.text).toContain("Ожидание подписи");
    expect(body.text).toContain("Ввести срок");
    expect(body.text).toContain("rep_1");
  });

  it("сбой связи не мешает работе: вкладки пустые, студия открыта", async () => {
    vi.spyOn(api, "listProposals").mockRejectedValue(new Error("нет связи"));
    vi.spyOn(api, "listTasks").mockRejectedValue(new Error("нет связи"));
    vi.spyOn(api, "listQuestions").mockRejectedValue(new Error("нет связи"));
    vi.spyOn(api, "listReports").mockRejectedValue(new Error("нет связи"));
    render(<Studio session={session(structuredModel())} busy={false} onSave={vi.fn(async () => true)} />);
    await act(async () => {});
    const tab = [...document.querySelectorAll(".problems-head button")].find((b) => b.textContent?.startsWith("Вопросы")) as HTMLElement;
    expect(tab.querySelector(".pill-count")!.textContent).toBe("0");
  });
});
