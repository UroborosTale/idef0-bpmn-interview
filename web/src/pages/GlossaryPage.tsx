import { useEffect, useState } from "react";
import { api, type GlossaryEntry, type PositionRow } from "../api/client";

const KIND_LABEL: Record<string, string> = { term: "Термин", role: "Роль", system: "Система", document: "Документ", department: "Подразделение" };

/** ФТ-М3.5: единые справочники (роли, подразделения, ИС, документы, термины), должности и связка роль<->должность. */
export default function GlossaryPage() {
  const [tab, setTab] = useState<"entries" | "proposals" | "positions" | "import">("entries");
  const [entries, setEntries] = useState<GlossaryEntry[]>([]);
  const [proposals, setProposals] = useState<GlossaryEntry[]>([]);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [roleMap, setRoleMap] = useState<{ role_key: string; position_key: string }[]>([]);
  const [kindFilter, setKindFilter] = useState("");

  async function reloadEntries() {
    setEntries(await api.listGlossary(kindFilter ? { kind: kindFilter, status: "confirmed" } : { status: "confirmed" }));
  }
  async function reloadProposals() {
    setProposals(await api.listGlossaryProposals());
  }
  async function reloadPositions() {
    setPositions(await api.listPositions());
    setRoleMap(await api.listRolePositionMap());
  }

  useEffect(() => {
    reloadEntries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindFilter]);

  useEffect(() => {
    if (tab === "proposals") reloadProposals();
    if (tab === "positions") reloadPositions();
  }, [tab]);

  return (
    <div className="card" style={{ margin: 16 }}>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Справочники и глоссарий</h2>
        <div className="spacer" />
        <button className={tab === "entries" ? "active" : ""} onClick={() => setTab("entries")}>Словарь</button>
        <button className={tab === "proposals" ? "active" : ""} onClick={() => setTab("proposals")}>
          Предложения{proposals.length > 0 ? ` (${proposals.length})` : ""}
        </button>
        <button className={tab === "positions" ? "active" : ""} onClick={() => setTab("positions")}>Должности</button>
        <button className={tab === "import" ? "active" : ""} onClick={() => setTab("import")}>Загрузка оргструктуры</button>
      </div>

      {tab === "entries" && (
        <EntriesTab entries={entries} kindFilter={kindFilter} setKindFilter={setKindFilter} onChanged={reloadEntries} />
      )}
      {tab === "proposals" && <ProposalsTab proposals={proposals} onChanged={reloadProposals} />}
      {tab === "positions" && <PositionsTab positions={positions} roleMap={roleMap} roles={entries.filter((e) => e.kind === "role")} onChanged={reloadPositions} />}
      {tab === "import" && <ImportTab />}
    </div>
  );
}

function EntriesTab({
  entries,
  kindFilter,
  setKindFilter,
  onChanged,
}: {
  entries: GlossaryEntry[];
  kindFilter: string;
  setKindFilter: (v: string) => void;
  onChanged: () => void;
}) {
  const [key, setKey] = useState("");
  const [kind, setKind] = useState("term");
  const [value, setValue] = useState("");

  return (
    <div>
      <div className="toolbar" style={{ marginTop: 10 }}>
        <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
          <option value="">Все типы</option>
          {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      <div className="chat-input-row" style={{ marginTop: 10 }}>
        <input placeholder="Ключ (напр. синоним)" value={key} onChange={(e) => setKey(e.target.value)} />
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input placeholder="Значение (напр. канонический термин)" value={value} onChange={(e) => setValue(e.target.value)} />
        <button
          disabled={!key.trim() || !value.trim()}
          onClick={async () => { await api.upsertGlossary(key.trim().toLowerCase(), kind, value.trim(), "confirmed"); setKey(""); setValue(""); onChanged(); }}
        >
          Добавить
        </button>
      </div>

      <table className="mono" style={{ width: "100%", fontSize: 13, marginTop: 12, borderCollapse: "collapse" }}>
        <thead><tr style={{ textAlign: "left" }}><th>Тип</th><th>Ключ</th><th>Значение</th><th></th></tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.key} style={{ borderTop: "1px solid #e5e7eb" }}>
              <td>{KIND_LABEL[e.kind] ?? e.kind}</td>
              <td>{e.key}</td>
              <td>{e.value}</td>
              <td><button onClick={async () => { await api.deleteGlossary(e.key); onChanged(); }}>✕</button></td>
            </tr>
          ))}
          {entries.length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 12 }}>Пусто.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function ProposalsTab({ proposals, onChanged }: { proposals: GlossaryEntry[]; onChanged: () => void }) {
  return (
    <div style={{ marginTop: 10 }}>
      <p className="muted" style={{ fontSize: 12 }}>
        Сущности, найденные в утверждённых моделях (роли, системы, документы) и предложенные к добавлению в общий словарь.
      </p>
      {proposals.length === 0 && <p className="muted">Предложений нет.</p>}
      <ul style={{ fontSize: 13 }}>
        {proposals.map((p) => (
          <li key={p.key} style={{ marginBottom: 4 }}>
            [{KIND_LABEL[p.kind] ?? p.kind}] {p.value}{" "}
            <button onClick={async () => { await api.confirmGlossaryProposal(p.key); onChanged(); }}>Подтвердить</button>{" "}
            <button onClick={async () => { await api.rejectGlossaryProposal(p.key); onChanged(); }}>Отклонить</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PositionsTab({
  positions,
  roleMap,
  roles,
  onChanged,
}: {
  positions: PositionRow[];
  roleMap: { role_key: string; position_key: string }[];
  roles: GlossaryEntry[];
  onChanged: () => void;
}) {
  const [title, setTitle] = useState("");
  const [department, setDepartment] = useState("");
  const [mapRole, setMapRole] = useState("");
  const [mapPosition, setMapPosition] = useState("");

  return (
    <div style={{ marginTop: 10 }}>
      <h4>Должности штатного расписания</h4>
      <div className="chat-input-row">
        <input placeholder="Название должности" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input placeholder="Подразделение" value={department} onChange={(e) => setDepartment(e.target.value)} />
        <button
          disabled={!title.trim()}
          onClick={async () => { await api.upsertPosition(title.trim().toLowerCase(), title.trim(), department.trim() || undefined); setTitle(""); setDepartment(""); onChanged(); }}
        >
          Добавить
        </button>
      </div>
      <table className="mono" style={{ width: "100%", fontSize: 13, marginTop: 10, borderCollapse: "collapse" }}>
        <thead><tr style={{ textAlign: "left" }}><th>Должность</th><th>Подразделение</th><th></th></tr></thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.key} style={{ borderTop: "1px solid #e5e7eb" }}>
              <td>{p.title}</td>
              <td>{p.department ?? "—"}</td>
              <td><button onClick={async () => { await api.deletePosition(p.key); onChanged(); }}>✕</button></td>
            </tr>
          ))}
          {positions.length === 0 && <tr><td colSpan={3} className="muted" style={{ padding: 12 }}>Пусто.</td></tr>}
        </tbody>
      </table>

      <h4 style={{ marginTop: 20 }}>Связка «роль в процессе ↔ должность» (М:М)</h4>
      <div className="chat-input-row">
        <select value={mapRole} onChange={(e) => setMapRole(e.target.value)}>
          <option value="">— роль —</option>
          {roles.map((r) => <option key={r.key} value={r.key}>{r.value}</option>)}
        </select>
        <select value={mapPosition} onChange={(e) => setMapPosition(e.target.value)}>
          <option value="">— должность —</option>
          {positions.map((p) => <option key={p.key} value={p.key}>{p.title}</option>)}
        </select>
        <button disabled={!mapRole || !mapPosition} onClick={async () => { await api.addRolePositionMap(mapRole, mapPosition); onChanged(); }}>
          Связать
        </button>
      </div>
      <ul style={{ fontSize: 13, marginTop: 8 }}>
        {roleMap.map((m, i) => {
          const role = roles.find((r) => r.key === m.role_key);
          const pos = positions.find((p) => p.key === m.position_key);
          return (
            <li key={i}>
              {role?.value ?? m.role_key} ↔ {pos?.title ?? m.position_key}{" "}
              <button onClick={async () => { await api.removeRolePositionMap(m.role_key, m.position_key); onChanged(); }}>✕</button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ImportTab() {
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<{ positions: number; departments: number; mappings: number } | null>(null);
  const [busy, setBusy] = useState(false);

  function onFile(f: File) {
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ""));
    reader.readAsText(f, "utf-8");
  }

  return (
    <div style={{ marginTop: 10 }}>
      <p className="muted" style={{ fontSize: 12 }}>
        Загрузка оргструктуры и штатного расписания — только CSV (колонки: <code>position,department,role</code>, заголовок обязателен;
        <code>role</code> необязательна — если указана, сразу создаётся связка роль↔должность). Импорт .xlsx намеренно не подключён:
        единственная npm-библиотека для чтения .xlsx содержит непропатченные уязвимости именно в пути разбора файлов.
      </p>
      <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      <textarea
        style={{ width: "100%", height: 140, marginTop: 8, fontFamily: "monospace", fontSize: 12 }}
        placeholder={"position,department,role\nСпециалист по закупкам,Закупки,Специалист"}
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
      />
      <div className="toolbar" style={{ marginTop: 8 }}>
        <button
          className="primary"
          disabled={!csv.trim() || busy}
          onClick={async () => {
            setBusy(true);
            try {
              setResult(await api.importOrgStructureCsv(csv));
            } finally {
              setBusy(false);
            }
          }}
        >
          Импортировать
        </button>
      </div>
      {result && (
        <div className="validation-item" style={{ marginTop: 10 }}>
          Загружено: должностей — {result.positions}, подразделений — {result.departments}, связок роль↔должность — {result.mappings}.
        </div>
      )}
    </div>
  );
}
