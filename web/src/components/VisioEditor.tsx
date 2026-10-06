import { useCallback, useEffect, useRef, useState } from "react";
import { api, type VisioPull, type VisioStatus } from "../api/client";
import type { SessionRecord } from "../types";

type Model = NonNullable<SessionRecord["model"]>;

const POLL_MS = 2000;

/**
 * Microsoft Visio как среда редактирования процесса. Приложение выгружает модель в .vsdx и открывает файл
 * в установленном Visio; после сохранения (Ctrl+S) правки читаются из файла и применяются к модели.
 */
export default function VisioEditor({ session, busy, onSave }: { session: SessionRecord; busy: boolean; onSave: (m: Model) => Promise<boolean> }) {
  const id = session.id;
  const [status, setStatus] = useState<VisioStatus | null>(null);
  const [pull, setPull] = useState<VisioPull | null>(null);
  const [source, setSource] = useState<"visio" | "upload">("visio");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const lastPulled = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    setWorking(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }, []);

  // опрос состояния файла: как только он сохранён в Visio, читаем правки
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await api.visioStatus(id);
        if (!alive) return;
        setStatus(s);
        if (s.exists && s.modified && s.mtime !== lastPulled.current && !pull) {
          lastPulled.current = s.mtime ?? null;
          const p = await api.visioPull(id);
          if (!alive) return;
          if (p.changes.length === 0) {
            // сохранили без изменений модели — просто синхронизируемся
            await api.visioApplied(id, p.mtime);
            setNote("Файл сохранён в Visio, изменений модели нет.");
          } else {
            setSource("visio");
            setPull(p);
            setNote(null);
          }
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, pull]);

  const open = (fresh: boolean) =>
    guard(async () => {
      const r = await api.visioOpen(id, fresh);
      setNote(
        r.launched
          ? r.resumed
            ? "Продолжаем правку: открыт файл с несохранёнными в модель правками. Чтобы выгрузить модель заново, нажмите «Выгрузить заново»."
            : "Файл открывается в Visio. Правьте диаграммы и сохраняйте (Ctrl+S) — правки появятся здесь."
          : `Visio не найден на этой машине. Файл подготовлен: ${r.file}`
      );
      setStatus(await api.visioStatus(id));
    });

  const apply = () =>
    guard(async () => {
      if (!pull) return;
      const ok = await onSave(pull.model);
      if (!ok) throw new Error("Не удалось сохранить модель (см. сообщение над вкладками)");
      if (source === "visio") await api.visioApplied(id, pull.mtime, true);
      setNote(`Применено изменений: ${pull.changes.length}. Модель и диаграммы обновлены.`);
      setPull(null);
    });

  const discard = () =>
    guard(async () => {
      if (source === "visio") await api.visioApplied(id, pull?.mtime);
      setPull(null);
      setNote("Правки из Visio отброшены — модель осталась прежней. «Выгрузить заново» обновит файл.");
    });

  const upload = (file: File) =>
    guard(async () => {
      const p = await api.visioImport(id, file);
      setSource("upload");
      if (p.changes.length === 0) setNote("В загруженном файле нет изменений модели.");
      else {
        setPull(p);
        setNote(null);
      }
    });

  const disabled = busy || working;
  return (
    <div>
      <h4 style={{ marginTop: 0 }}>Редактор Visio</h4>
      <p className="muted" style={{ marginTop: 0 }}>
        Диаграммы BPMN и IDEF0 правятся в Microsoft Visio: файл содержит страницы BPMN, A-0, A0 и вложенных функций. Двигайте блоки, переименовывайте
        (F2), протягивайте соединители между фигурами, удаляйте и копируйте (Ctrl+D) — после сохранения правки вернутся в модель.
      </p>

      {status && !status.available && (
        <div className="validation-item warning">Visio на этой машине не найден (нет сопоставления .vsdx). Файл можно подготовить и открыть вручную на другой машине, затем загрузить обратно.</div>
      )}
      {error && <div className="validation-item error">{error}</div>}
      {note && <div className="validation-item" style={{ background: "#eef2ff" }}>{note}</div>}

      <div className="toolbar">
        <button className="primary" disabled={disabled || !session.model} onClick={() => open(false)}>
          {status?.exists ? "Открыть в Visio" : "Редактировать в Visio"}
        </button>
        {status?.exists && (
          <button disabled={disabled} onClick={() => open(true)} title="Собрать файл из текущей модели; прежний файл с правками не используется">
            Выгрузить заново
          </button>
        )}
        <button disabled={disabled} onClick={() => fileInput.current?.click()}>
          Загрузить .vsdx…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".vsdx"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) upload(f);
          }}
        />
        <a href={api.exportUrl(id, "vsdx")} target="_blank" rel="noreferrer">
          <button disabled={!session.model}>Скачать .vsdx</button>
        </a>
      </div>

      {status?.exists && (
        <p className="muted" style={{ fontSize: 12 }}>
          Файл: {status.file}
          {status.mtime ? ` · сохранён ${new Date(status.mtime).toLocaleTimeString()}` : ""}
        </p>
      )}

      {pull && (
        <div className="card" style={{ marginTop: 12 }}>
          <h4 style={{ marginTop: 0 }}>{source === "visio" ? "Файл сохранён в Visio" : "Загруженный файл"}: изменений {pull.changes.length}</h4>
          {pull.stale && (
            <div className="validation-item warning">
              Модель менялась после выгрузки файла (например, во встроенном редакторе). Правки Visio будут наложены поверх; проверьте список ниже.
            </div>
          )}
          <ul style={{ marginTop: 6 }}>
            {pull.changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
          {pull.warnings.length > 0 && (
            <>
              <div className="muted" style={{ fontSize: 12 }}>Не учтено:</div>
              <ul style={{ marginTop: 4, fontSize: 12 }}>
                {pull.warnings.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </>
          )}
          <div className="toolbar">
            <button className="primary" disabled={disabled} onClick={apply}>
              Применить к модели
            </button>
            <button disabled={disabled} onClick={discard}>
              Отбросить
            </button>
          </div>
        </div>
      )}

      <details style={{ marginTop: 12 }}>
        <summary>Что можно править в Visio</summary>
        <ul style={{ fontSize: 13 }}>
          <li><b>Новые элементы</b> — из трафарета документа (в Visio: панель «Фигуры» → «Другие фигуры» → «Показать трафарет документа»): задача, подпроцесс, шлюзы, события, функция IDEF0. Фигура сразу получает нужный вид.</li>
          <li><b>BPMN:</b> положение и названия шагов; перенос шага в другую дорожку меняет исполнителя; новый шаг — фигура из трафарета, копия существующей (Ctrl+D) или нарисованный прямоугольник с текстом; соединитель между двумя шагами — новая связь, текст соединителя — условие; удаление фигуры или соединителя удаляет шаг или связь.</li>
          <li><b>IDEF0 (A0 и вложенные страницы):</b> положение и названия функций; новые функции (копия блока или прямоугольник); соединитель между блоками — стрелка «выход → вход» (если конец приклеен к верхней стороне блока — «выход → управление»); текст стрелки — название данных; удаление стрелки или блока.</li>
          <li>Тип фигур, ICOM-стрелки на границе диаграммы и страница A-0 (производная) из Visio не читаются — они строятся из модели.</li>
        </ul>
      </details>
    </div>
  );
}
