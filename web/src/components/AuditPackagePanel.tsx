import { api } from "../api/client";
import type { SessionRecord } from "../types";

/** ФТ-М6.4: пакет документов к аудиту по процессу — обложка со сводкой, PDF, .zip со всеми документами. */
export default function AuditPackagePanel({ session }: { session: SessionRecord }) {
  return (
    <div>
      <div className="toolbar">
        <h4 style={{ margin: 0 }}>Пакет к аудиту</h4>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Единый комплект документов процесса для проверки соответствия: паспорт процесса, результат чек-листа процессного подхода, диаграммы
        (BPMN, IDEF0), матрица ответственности RACI, текст регламента, история версий. Архив .zip дополнительно содержит модель в JSON,
        BPMN XML, IDEF0 SVG, регламент .docx и матрицу RACI .xlsx как отдельные файлы.
      </p>
      <div className="toolbar" style={{ marginTop: 10 }}>
        <a href={api.auditPackagePreviewUrl(session.id)} target="_blank" rel="noreferrer"><button>Предпросмотр (HTML)</button></a>
        <a href={api.auditPackagePdfUrl(session.id)} target="_blank" rel="noreferrer"><button className="primary">Скачать PDF</button></a>
        <a href={api.auditPackageZipUrl(session.id)} target="_blank" rel="noreferrer"><button>Скачать .zip</button></a>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Если PDF-рендеринг недоступен в этом окружении (нет Chromium), используйте предпросмотр и печать в PDF из браузера.
      </p>
    </div>
  );
}
