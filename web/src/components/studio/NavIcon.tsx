export type NavIconKind = "folder" | "process" | "diagram" | "subprocess" | "operation" | "bpmn" | "step";

const INK = "#35507d";

/** Значки дерева процессов в духе Business Studio: папка, процесс, диаграмма A0, подпроцесс, операция, диаграмма BPMN. */
export default function NavIcon({ kind }: { kind: NavIconKind }) {
  const common = { fill: "none", stroke: INK, strokeWidth: 1.1, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
  return (
    <svg className={`nav-icon nav-icon-${kind}`} viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      {kind === "folder" && <path d="M1.5 3.5h4.2l1.4 1.6h7.4v8h-13z" fill="#f5d585" stroke="#a97c16" strokeWidth={1} strokeLinejoin="round" />}
      {kind === "process" && (
        // блок IDEF0 со стрелками со всех сторон; двойная рамка — процесс верхнего уровня
        <g {...common}>
          <rect x="4.2" y="4.2" width="7.6" height="7.6" fill="#fff" />
          <rect x="5.8" y="5.8" width="4.4" height="4.4" fill="#fff" />
          <path d="M8 .8v2.6M8 12.6v2.6M.8 8h2.6M12.6 8h2.6" />
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
          <rect x="4.6" y="4.6" width="6.8" height="6.8" fill="#fff" />
          <path d="M8 1v3.6M8 11.4V15M1 8h3.6M11.4 8H15" />
        </g>
      )}
      {kind === "operation" && (
        // операция: рамка с диаграммой внутри
        <g {...common}>
          <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="#fff" />
          <rect x="3" y="4.2" width="3" height="2.4" fill="#fff" />
          <rect x="9.6" y="8.6" width="3" height="2.4" fill="#fff" />
          <path d="M4.5 6.6v2.8h5.1" />
        </g>
      )}
      {kind === "bpmn" && (
        // диаграмма BPMN операции: рамка с цепочкой фигур
        <g {...common}>
          <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="#fff" />
          <circle cx="4.3" cy="8" r="1.3" fill="#d7f0dc" />
          <rect x="7" y="6.6" width="3.2" height="2.8" rx=".6" fill="#e8eef7" />
          <path d="M5.6 8H7M10.2 8h1.4" />
          <path d="M13 6.8l1 1.2-1 1.2-1-1.2z" fill="#fbe9a8" />
        </g>
      )}
      {kind === "step" && (
        // шаг диаграммы: задача, соединённая стрелкой
        <g {...common}>
          <rect x="1.5" y="3.5" width="8" height="6" rx="1.2" fill="#e8eef7" />
          <path d="M5.5 9.5v3h8M11.8 11.2l1.7 1.3-1.7 1.3" />
        </g>
      )}
    </svg>
  );
}
