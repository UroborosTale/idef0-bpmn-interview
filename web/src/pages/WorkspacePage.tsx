import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { SessionRecord } from "../types";
import TextPanel from "../components/TextPanel";
import BpmnDiagram from "../components/bpmn-editor/BpmnDiagram";
import BpmnEditor from "../components/bpmn-editor/BpmnEditor";
import Idef0Editor from "../components/idef0-editor/Idef0Editor";
import VisioEditor from "../components/VisioEditor";
import Idef0Viewer from "../components/Idef0Viewer";
import GapsPanel from "../components/GapsPanel";
import ValidationPanel from "../components/ValidationPanel";
import ModelPanel from "../components/ModelPanel";
import ChatPanel from "../components/ChatPanel";
import CommentsPanel from "../components/CommentsPanel";
import ExportsPanel from "../components/ExportsPanel";
import IngestPanel from "../components/IngestPanel";
import VersionsPanel from "../components/VersionsPanel";
import RaciPanel from "../components/RaciPanel";
import RegulationPanel from "../components/RegulationPanel";
import MultiInterviewPanel from "../components/MultiInterviewPanel";
import VerificationPanel from "../components/VerificationPanel";
import ReviewPanel from "../components/ReviewPanel";
import AnalyticsPanel from "../components/AnalyticsPanel";
import ChecklistPanel from "../components/ChecklistPanel";
import TraceabilityPanel from "../components/TraceabilityPanel";
import JobDescriptionsPanel from "../components/JobDescriptionsPanel";
import AgentRunsPanel from "../components/AgentRunsPanel";
import HypothesesPanel from "../components/HypothesesPanel";
import MiningPanel from "../components/MiningPanel";
import BpmsExportPanel from "../components/BpmsExportPanel";
import DiagramReimportPanel from "../components/DiagramReimportPanel";
import AuditPackagePanel from "../components/AuditPackagePanel";

type Tab =
  | "text" | "bpmn" | "visio" | "editor" | "idef0" | "idef0Editor" | "model" | "gaps" | "validation" | "export" | "versions" | "raci" | "regulation"
  | "multiInterview" | "verification" | "review" | "analytics" | "checklist" | "traceability" | "jobDescriptions" | "agentRuns"
  | "hypotheses" | "mining" | "bpms" | "diagramReimport" | "auditPackage" | "chat";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function WorkspacePage({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [tab, setTab] = useState<Tab>("text");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const onProgress = (p: { done: number; total: number; stage?: string }) => setProgress(`${p.stage ?? "обработка"}: ${p.done} из ${p.total} частей текста`);

  const reload = useCallback(async () => {
    const s = await api.getSession(sessionId);
    setSession(s);
  }, [sessionId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // обработка, запущенная раньше (до перезагрузки страницы), — продолжаем следить за ней
  useEffect(() => {
    let alive = true;
    api.activeJob(sessionId).then(async (job) => {
      if (!job || !alive) return;
      setBusy(true);
      try {
        const s = await api.waitJob(job, sessionId, onProgress);
        if (alive) setSession(s);
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) {
          setBusy(false);
          setProgress(null);
        }
      }
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionId]);

  useEffect(() => {
    if (session?.mode === "B") setTab("chat");
  }, [session?.id]);

  if (!session) return <p className="muted">Загрузка сессии…</p>;

  const model = session.model;
  const selectedNode = model?.nodes.find((n) => n.id === selectedId) ?? null;
  const highlightFragmentId = selectedNode?.source?.[0]?.fragment_id ?? null;

  function selectElement(id: string | null) {
    setSelectedId(id);
  }

  async function withBusy<T>(fn: () => Promise<T>) {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  /** Сохранение из редакторов диаграмм: модель + пересборка BPMN/IDEF0, чтобы просмотр и экспорт совпали с нарисованным. */
  async function saveModel(m: NonNullable<SessionRecord["model"]>): Promise<boolean> {
    const ok = await withBusy(async () => {
      await api.putModel(sessionId, m);
      setSession(await api.rebuildDiagrams(sessionId));
      return true;
    });
    return ok === true;
  }

  const tabs: { key: Tab; label: string }[] = [
    ...(session.mode === "B" ? [{ key: "chat" as Tab, label: "Интервью" }] : []),
    { key: "text", label: "Текст" },
    { key: "bpmn", label: "BPMN" },
    { key: "visio", label: "Редактор Visio" },
    { key: "editor", label: "Редактор BPMN (встроенный)" },
    { key: "idef0", label: "IDEF0" },
    { key: "idef0Editor", label: "Редактор IDEF0 (встроенный)" },
    { key: "model", label: "Модель" },
    { key: "gaps", label: `Пробелы${model ? ` (${model.gaps.filter((g) => g.status === "open").length})` : ""}` },
    { key: "validation", label: `Валидация${session.validation.length ? ` (${session.validation.length})` : ""}` },
    { key: "raci", label: "RACI" },
    { key: "analytics", label: "Аналитика" },
    { key: "hypotheses", label: "Гипотезы TO-BE" },
    { key: "mining", label: "Process mining" },
    { key: "bpms", label: "Экспорт в BPMS" },
    { key: "diagramReimport", label: "Правки из редакторов" },
    { key: "auditPackage", label: "Пакет к аудиту" },
    { key: "checklist", label: "Чек-лист" },
    { key: "traceability", label: "Трассировка требований" },
    { key: "jobDescriptions", label: "Должностные инструкции" },
    { key: "agentRuns", label: "Журнал агентов" },
    { key: "regulation", label: "Регламент" },
    { key: "multiInterview", label: "Мультиинтервью" },
    { key: "verification", label: "Верификация" },
    { key: "review", label: "Согласование" },
    { key: "versions", label: "Версии" },
    { key: "export", label: "Экспорт" },
  ];

  return (
    <div>
      <div className="toolbar">
        <button onClick={onBack}>← Назад</button>
        <h2 style={{ margin: 0 }}>{session.title}</h2>
        <span className={`pill status-${session.status}`}>{session.status}</span>
        {session.diagramsStale && (
          <button onClick={() => withBusy(async () => setSession(await api.rebuildDiagrams(sessionId)))}>
            Пересобрать диаграммы (модель изменена)
          </button>
        )}
        <div className="spacer" />
        {session.provider && <span className="muted" style={{ fontSize: 12 }}>LLM: {session.provider}</span>}
      </div>

      {error && <div className="validation-item error">{error}</div>}
      {progress && <div className="validation-item" style={{ background: "#eef2ff" }}>Идёт обработка — {progress}. Можно переключаться между вкладками.</div>}

      {session.mode === "A" && session.status !== "ready" && tab !== "chat" && (
        <IngestPanel
          hasFragments={session.fragments.length > 0}
          busy={busy}
          onIngestText={(text, append, anonymize) =>
            withBusy(async () => setSession(await api.ingestText(sessionId, text, { append, anonymize })))
          }
          onUploadFile={(file, append, anonymize) =>
            withBusy(async () => {
              const b64 = await fileToBase64(file);
              setSession(await api.uploadFile(sessionId, file.name, b64, { append, anonymize }));
            })
          }
          onRun={() => withBusy(async () => setSession(await api.runPipeline(sessionId, onProgress)))}
        />
      )}

      {session.mode === "A" && session.status === "ready" && (
        <div className="toolbar">
          <button disabled={busy} onClick={() => withBusy(async () => setSession(await api.runPipeline(sessionId, onProgress)))}>Перезапустить обработку текста</button>
        </div>
      )}

      <div className="ws-tabs">
        {tabs.map((t) => (
          <button key={t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "chat" && session.mode === "B" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, height: "calc(100vh - 260px)" }}>
          <div className="card" style={{ overflow: "hidden" }}>
            {session.chat.length === 0 ? (
              <div>
                <p>Начните интервью с владельцем процесса — система будет задавать уточняющие вопросы по ходу разговора.</p>
                <button className="primary" onClick={() => withBusy(async () => setSession(await api.interviewStart(sessionId)))}>
                  Начать интервью
                </button>
              </div>
            ) : (
              <ChatPanel
                chat={session.chat}
                busy={busy}
                finished={session.status === "completed"}
                onSend={(text) => withBusy(async () => setSession(await api.interviewTurn(sessionId, text)))}
                onFinish={() => withBusy(async () => setSession(await api.interviewFinish(sessionId)))}
              />
            )}
          </div>
          <div className="card" style={{ overflow: "auto" }}>
            <h4 style={{ marginTop: 0 }}>Живое превью BPMN</h4>
            <BpmnDiagram model={model} selectedId={selectedId} onSelect={selectElement} height={420} />
            {selectedId && (
              <button
                style={{ marginTop: 8 }}
                onClick={() => withBusy(async () => setSession(await api.interviewFlag(sessionId, selectedId, prompt("Что не так с этим элементом?") || undefined)))}
              >
                Отметить выбранный элемент как неверный
              </button>
            )}
          </div>
        </div>
      )}

      {tab === "visio" && model && <VisioEditor session={session} busy={busy} onSave={saveModel} />}
      {tab === "visio" && !model && <p className="muted">Модели ещё нет — загрузите текст интервью и запустите обработку.</p>}
      {tab === "editor" && model && (
        <BpmnEditor model={model} validation={session.validation} busy={busy} onSave={saveModel} draftId={`${session.id}:bpmn`} draftBase={session.updatedAt} />
      )}
      {tab === "idef0Editor" && model && (
        <Idef0Editor model={model} validation={session.validation} busy={busy} onSave={saveModel} draftId={`${session.id}:idef0`} draftBase={session.updatedAt} />
      )}
      {(tab === "editor" || tab === "idef0Editor") && !model && (
        <p className="muted">Модели ещё нет — загрузите текст интервью и запустите обработку.</p>
      )}

      {tab !== "chat" && tab !== "visio" && tab !== "editor" && tab !== "idef0Editor" && (
        <div className="split">
          <div className="left">
            {tab === "text" && <TextPanel fragments={session.fragments} highlightId={highlightFragmentId} />}
            {tab === "bpmn" && <BpmnDiagram model={model} selectedId={selectedId} onSelect={selectElement} />}
            {tab === "idef0" && <Idef0Viewer idef0={session.idef0} />}
            {tab === "model" && model && (
              <ModelPanel
                model={model}
                selectedId={selectedId}
                onSelectElement={selectElement}
                onUpdateNode={(nodeId, patch) =>
                  withBusy(async () => {
                    const updatedModel = {
                      ...model,
                      nodes: model.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)),
                    };
                    setSession(await api.putModel(sessionId, updatedModel));
                  })
                }
              />
            )}
            {tab === "model" && !model && <p className="muted">Модель ещё не построена.</p>}
            {tab === "gaps" && model && (
              <GapsPanel
                gaps={model.gaps}
                busy={busy}
                sessionId={sessionId}
                onChanged={reload}
                onSelectElement={(id) => {
                  selectElement(id);
                  setTab("text");
                }}
                onAnswer={(gapId, text) => withBusy(async () => setSession(await api.answerGap(sessionId, gapId, text, onProgress))).then(() => {})}
              />
            )}
            {tab === "gaps" && !model && <p className="muted">Модель ещё не построена.</p>}
            {tab === "validation" && <ValidationPanel issues={session.validation} onSelectElement={(id) => { selectElement(id); setTab("model"); }} />}
            {tab === "raci" && model && <RaciPanel session={session} onChanged={reload} />}
            {tab === "raci" && !model && <p className="muted">Модель ещё не построена.</p>}
            {tab === "analytics" && model && <AnalyticsPanel session={session} onChanged={reload} />}
            {tab === "analytics" && !model && <p className="muted">Модель ещё не построена.</p>}
            {tab === "checklist" && model && <ChecklistPanel session={session} />}
            {tab === "checklist" && !model && <p className="muted">Модель ещё не построена.</p>}
            {tab === "traceability" && model && <TraceabilityPanel session={session} onChanged={reload} />}
            {tab === "traceability" && !model && <p className="muted">Модель ещё не построена.</p>}
            {tab === "jobDescriptions" && model && <JobDescriptionsPanel session={session} />}
            {tab === "jobDescriptions" && !model && <p className="muted">Модель ещё не построена.</p>}
            {tab === "agentRuns" && <AgentRunsPanel sessionId={session.id} />}
            {tab === "hypotheses" && model && <HypothesesPanel session={session} />}
            {tab === "hypotheses" && !model && <p className="muted">Модель ещё не построена.</p>}
            {tab === "mining" && model && <MiningPanel session={session} onChanged={reload} />}
            {tab === "mining" && !model && <p className="muted">Модель ещё не построена.</p>}
            {tab === "bpms" && model && <BpmsExportPanel session={session} />}
            {tab === "bpms" && !model && <p className="muted">Модель ещё не построена.</p>}
            {tab === "diagramReimport" && model && <DiagramReimportPanel session={session} onChanged={reload} />}
            {tab === "diagramReimport" && !model && <p className="muted">Модель ещё не построена.</p>}
            {tab === "auditPackage" && model && <AuditPackagePanel session={session} />}
            {tab === "auditPackage" && !model && <p className="muted">Модель ещё не построена.</p>}
            {tab === "regulation" && model && <RegulationPanel session={session} />}
            {tab === "regulation" && !model && <p className="muted">Модель ещё не построена.</p>}
            {tab === "multiInterview" && <MultiInterviewPanel session={session} onChanged={reload} />}
            {tab === "verification" && model && <VerificationPanel session={session} onChanged={reload} />}
            {tab === "verification" && !model && <p className="muted">Модель ещё не построена.</p>}
            {tab === "review" && <ReviewPanel session={session} onChanged={reload} />}
            {tab === "versions" && <VersionsPanel session={session} onChanged={reload} />}
            {tab === "export" && <ExportsPanel session={session} />}
          </div>
          <div className="right card">
            <h4 style={{ marginTop: 0 }}>
              {selectedNode ? selectedNode.name : "Инспектор"}
            </h4>
            {selectedNode && (
              <div style={{ fontSize: 12, marginBottom: 10 }}>
                <div className="muted">Уверенность: {selectedNode.confidence.toFixed(2)} {selectedNode.status === "hypothesis" && <span className="badge-hyp">гипотеза</span>}</div>
                {selectedNode.source[0] && (
                  <div style={{ marginTop: 6 }}>
                    <div className="muted">Источник [{selectedNode.source[0].fragment_id}]:</div>
                    <div style={{ fontStyle: "italic" }}>«{selectedNode.source[0].quote}»</div>
                    <button style={{ marginTop: 6 }} onClick={() => setTab("text")}>Показать в тексте</button>
                  </div>
                )}
              </div>
            )}
            <CommentsPanel
              comments={session.comments}
              selectedId={selectedId}
              onAdd={(elementId, text) => withBusy(async () => setSession(await api.addComment(sessionId, elementId, text))).then(() => {})}
            />
          </div>
        </div>
      )}
    </div>
  );
}
