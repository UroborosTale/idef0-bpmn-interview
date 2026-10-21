import { useState } from "react";
import type { Idef0Result } from "../types";

// "decomposition" | "context" | "tree" — основные диаграммы; "child:<код>" — декомпозиция вложенной функции
const LABELS: Record<string, string> = {
  decomposition: "Декомпозиция A0",
  context: "Контекст A-0",
  tree: "Узловое дерево",
};

export default function Idef0Viewer({ idef0 }: { idef0: Idef0Result | null }) {
  const [diagram, setDiagram] = useState<string>("decomposition");
  if (!idef0) return <p className="muted">Диаграмма IDEF0 ещё не сгенерирована.</p>;

  const children = idef0.children ?? [];
  const tabs = [...Object.keys(LABELS), ...children.map((c) => `child:${c.code}`)];
  const labelOf = (d: string) => LABELS[d] ?? `Декомпозиция ${d.slice("child:".length)}`;
  const svg =
    { decomposition: idef0.decompositionSvg, context: idef0.contextSvg, tree: idef0.nodeTreeSvg }[diagram] ??
    children.find((c) => `child:${c.code}` === diagram)?.svg ??
    idef0.decompositionSvg;

  return (
    <div>
      <div className="diagram-tabs">
        {tabs.map((d) => (
          <button key={d} className={d === diagram ? "primary" : ""} onClick={() => setDiagram(d)} title={d.startsWith("child:") ? children.find((c) => `child:${c.code}` === d)?.name : undefined}>
            {labelOf(d)}
          </button>
        ))}
      </div>
      <div className="idef0-view" style={{ border: "1px solid var(--border)", borderRadius: 8, background: "#fff", overflow: "auto", padding: 8 }}
           dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}
