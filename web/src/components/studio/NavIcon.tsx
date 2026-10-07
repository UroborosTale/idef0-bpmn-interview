export type NavIconKind = "folder" | "process" | "diagram" | "subprocess" | "operation" | "bpmn";

const INK = "#35507d";

/** Значки дерева процессов в духе Business Studio: папка, процесс, диаграмма A0, подпроцесс, операция, диаграмма BPMN. */
export default function NavIcon({ kind }: { kind: NavIconKind }) {
  const common = { fill: "none", stroke: INK, strokeWidth: 1.1, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
  return (
    <svg className={`nav-icon nav-icon-${kind}`} viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      {kind === "folder" && <path d="M1.5 3.5h4.2l1.4 1.6h7.4v8h-13z" fill="#f5d585" stroke="#a97c16" strokeWidth={1} strokeLinejoin="round" />}
      {kind === "process" && (
        <g {...common}>
          <circle cx="8" cy="8" r="3" fill="#dbe6f8" />
          <path d="M8 1.6v2.2M8 12.2v2.2M1.6 8h2.2M12.2 8h2.2M3.5 3.5l1.5 1.5M11 11l1.5 1.5M12.5 3.5L11 5M5 11l-1.5 1.5" />
        </g>
      )}
      {kind === "diagram" && (
        <g {...common}>
          <rect x="1.8" y="1.8" width="12.4" height="12.4" fill="#fff" />
          <rect x="5" y="5.2" width="6" height="5" fill="#dbe6f8" />
          <path d="M1.8 7.7H5M11 7.7h3.2" />
        </g>
      )}
      {kind === "subprocess" && (
        <g {...common}>
          <rect x="1.8" y="3.2" width="12.4" height="9.6" rx="1.2" fill="#c9daf5" />
          <path d="M4.2 8h7.6M8 5.6v4.8" />
        </g>
      )}
      {kind === "operation" && (
        <g {...common}>
          <rect x="1.8" y="3.2" width="12.4" height="9.6" rx="1.2" fill="#fff" />
          <path d="M4.2 6.2h7.6M4.2 8.2h7.6M4.2 10.2h4.6" />
        </g>
      )}
      {kind === "bpmn" && (
        <g {...common}>
          <circle cx="3" cy="8" r="1.6" fill="#d7f0dc" />
          <rect x="5.7" y="5.7" width="4.4" height="4.6" rx="1" fill="#fff" />
          <path d="M4.6 8h1.1M10.1 8h1.1" />
          <path d="M13 5.8l1.8 2.2-1.8 2.2-1.8-2.2z" fill="#fbe9a8" />
        </g>
      )}
    </svg>
  );
}
