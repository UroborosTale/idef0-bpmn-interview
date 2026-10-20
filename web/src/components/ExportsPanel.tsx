import { api } from "../api/client";
import type { SessionRecord } from "../types";

export default function ExportsPanel({ session }: { session: SessionRecord }) {
  const id = session.id;

  const links: { label: string; path: string; disabled?: boolean }[] = [
    { label: "BPMN 2.0 XML (.bpmn)", path: "bpmn" },
    { label: "IDEF0 A0, декомпозиция (.svg)", path: "idef0/decomposition.svg" },
    { label: "IDEF0 A-0, контекст (.svg)", path: "idef0/context.svg" },
    { label: "IDEF0 узловое дерево (.svg)", path: "idef0/tree.svg" },
    { label: "IDEF0 (draw.io .xml)", path: "idef0.drawio" },
    { label: "Visio (.vsdx) — BPMN и все диаграммы IDEF0", path: "vsdx" },
    { label: "Промежуточная модель (.json)", path: "model.json" },
    { label: "Лист уточняющих вопросов (.txt)", path: "questions.txt" },
    { label: "Протокол интервью (.md)", path: "protocol.md" },
    { label: "Проблемы и предложения TO-BE (.md)", path: "statements.md" },
    { label: "Альбом моделей — HTML", path: "album.html" },
    { label: "Альбом моделей — PDF", path: "album.pdf" },
  ];

  return (
    <div>
      <h4>Экспорт</h4>
      <div className="exports-row">
        {links.map((l) => (
          <a key={l.path} href={api.exportUrl(id, l.path)} {...(l.path === "album.html" ? { target: "_blank", rel: "noreferrer" } : { download: "" })}>
            <button disabled={!session.model}>{l.label}</button>
          </a>
        ))}
      </div>
    </div>
  );
}
