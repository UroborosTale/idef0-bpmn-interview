import type { ReactNode } from "react";

/**
 * Значки ленты студии: контуры тёмно-серым с цветным акцентом, как в офисных лентах. Нарисованы здесь заново
 * (значки Business Studio и Microsoft не используются). Размер задаёт CSS: .ri — мелкий, .rb.big .ri — крупный.
 */
export type RibbonIconName =
  | "save" | "apply" | "undo" | "redo" | "prev" | "next" | "up" | "down" | "find" | "labels" | "numbers"
  | "bpmn" | "idef0" | "addfn" | "wizard" | "duplicate" | "navigator" | "properties" | "fullscreen" | "checks"
  | "suggest" | "export" | "print" | "pdf" | "import" | "image" | "paper" | "refresh" | "reports" | "actions";

const INK = "#3b4a5a";
const ACC = "#1a6fc4";
const TINT = "#dbe8f8";

const ICONS: Record<RibbonIconName, ReactNode> = {
  save: (
    <>
      <path d="M4.5 4.5h12.2l2.8 2.8v12.2h-15z" />
      <rect x="7.5" y="4.5" width="7" height="4.5" fill={TINT} />
      <rect x="7" y="13" width="10" height="6.5" fill={TINT} />
    </>
  ),
  apply: (
    <>
      <path d="M6 3.5h8l4 4v13H6z" />
      <path d="M14 3.5v4h4" />
      <path d="M8.8 14.2l2.6 2.6 4.6-5" stroke={ACC} strokeWidth="1.8" />
    </>
  ),
  undo: <path d="M9 5 4 10l5 5M4 10h9.5a5.5 5.5 0 0 1 0 11H10" stroke={ACC} />,
  redo: <path d="M15 5l5 5-5 5M20 10h-9.5a5.5 5.5 0 0 0 0 11H14" stroke={ACC} />,
  prev: <path d="M14.5 5.5 8 12l6.5 6.5" strokeWidth="2" />,
  next: <path d="M9.5 5.5 16 12l-6.5 6.5" strokeWidth="2" />,
  up: <path d="M12 19V6M6 11.5 12 5.5l6 6" strokeWidth="1.8" />,
  down: <path d="M12 5v13M6 12.5l6 6 6-6" strokeWidth="1.8" />,
  find: (
    <>
      <circle cx="10.5" cy="10.5" r="5.5" fill={TINT} />
      <path d="m15 15 5.5 5.5" strokeWidth="2" />
      <circle cx="10.5" cy="10.5" r="1.4" fill={ACC} stroke="none" />
    </>
  ),
  labels: <text x="3" y="17" fontSize="12.5" fontWeight="700" fill={INK} stroke="none" fontFamily="Segoe UI, Arial, sans-serif">Аб</text>,
  numbers: <text x="3.5" y="17" fontSize="13" fontWeight="700" fill={INK} stroke="none" fontFamily="Segoe UI, Arial, sans-serif">№</text>,
  bpmn: (
    <>
      <circle cx="4.8" cy="12" r="2.3" fill="#d7f0dc" />
      <rect x="9" y="8.5" width="7" height="7" rx="1.6" fill={TINT} />
      <circle cx="20" cy="12" r="2" strokeWidth="2.2" />
      <path d="M7.2 12H9M16 12h2" />
    </>
  ),
  idef0: (
    <>
      <rect x="3.5" y="4" width="9" height="6.5" fill={TINT} />
      <rect x="11.5" y="13.5" width="9" height="6.5" fill={TINT} />
      <path d="M12.5 7.2h3.5v6.3M3 7.2H1.5M20.5 16.8H22" />
    </>
  ),
  addfn: (
    <>
      <rect x="3.5" y="5.5" width="13" height="10" fill={TINT} />
      <path d="M19 14v7M15.5 17.5h7" stroke={ACC} strokeWidth="1.9" />
    </>
  ),
  wizard: (
    <>
      <rect x="8.5" y="3.5" width="7" height="4.5" fill={TINT} />
      <rect x="3" y="15.5" width="7" height="4.5" />
      <rect x="14" y="15.5" width="7" height="4.5" />
      <path d="M12 8v3.5M6.5 15.5v-4h11v4" />
    </>
  ),
  duplicate: (
    <>
      <rect x="4.5" y="4.5" width="10" height="10" fill={TINT} />
      <rect x="9.5" y="9.5" width="10" height="10" fill="#fff" />
    </>
  ),
  navigator: (
    <>
      <rect x="3.5" y="4" width="17" height="16" />
      <path d="M9.5 4v16" />
      <path d="M5.2 8h2.6M5.2 11h2.6M5.2 14h2.6" stroke={ACC} />
    </>
  ),
  properties: (
    <>
      <rect x="3.5" y="4" width="17" height="16" />
      <path d="M14.5 4v16" />
      <path d="M16.2 8h2.6M16.2 11h2.6M16.2 14h2.6" stroke={ACC} />
    </>
  ),
  fullscreen: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" strokeWidth="1.8" />,
  checks: (
    <>
      <path d="M12 3.5 19.5 6v6c0 4.2-3 7.2-7.5 8.5C7.500 19.200 4.500 16.200 4.500 12V6z" fill={TINT} />
      <path d="m8.5 12 2.7 2.7 4.5-5" stroke={ACC} strokeWidth="1.8" />
    </>
  ),
  suggest: (
    <>
      <path d="M4.5 5h15v10h-7l-4 4v-4h-4z" fill={TINT} />
      <path d="M8.5 9h7M8.5 11.8h4.5" stroke={ACC} />
    </>
  ),
  export: (
    <>
      <path d="M4.5 14v5.5h15V14" />
      <path d="M12 15V4.5M7.5 9 12 4.5 16.5 9" stroke={ACC} strokeWidth="1.8" />
    </>
  ),
  print: (
    <>
      <path d="M7 9V4h10v5" />
      <rect x="3.5" y="9" width="17" height="8" fill={TINT} />
      <rect x="7" y="14" width="10" height="6" fill="#fff" />
    </>
  ),
  pdf: (
    <>
      <path d="M6 3.5h8l4 4v13H6z" />
      <path d="M14 3.5v4h4" />
      <path d="M8.5 15.5h7" stroke={ACC} strokeWidth="1.8" />
    </>
  ),
  import: (
    <>
      <path d="M4.5 14v5.5h15V14" />
      <path d="M12 4.5V15M7.5 10.5 12 15l4.5-4.5" stroke={ACC} strokeWidth="1.8" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" />
      <circle cx="9" cy="10" r="1.6" fill={ACC} stroke="none" />
      <path d="m4 18 5-5 3 3 3.5-4.5 4.5 5.5" fill={TINT} />
    </>
  ),
  refresh: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.4-5.5" />
      <path d="M19.5 4.5v4.5H15" stroke={ACC} strokeWidth="1.8" />
    </>
  ),
  reports: (
    <>
      <path d="M6 3.5h8l4 4v13H6z" />
      <path d="M14 3.5v4h4" />
      <path d="M8.5 17v-3M11.5 17v-5.5M14.5 17v-2" stroke={ACC} strokeWidth="1.8" />
    </>
  ),
  actions: (
    <>
      <path d="M4.5 7h15M4.5 12h15M4.5 17h15" strokeWidth="1.8" />
    </>
  ),
  paper: (
    <>
      <path d="M6 3.5h12v17H6z" />
      <path d="M9 8h6M9 11h6M9 14h4" stroke={ACC} />
    </>
  ),
};

export default function RibbonIcon({ name }: { name: RibbonIconName }) {
  return (
    <svg className="ri" viewBox="0 0 24 24" fill="none" stroke={INK} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}
