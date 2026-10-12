/** Предел текста в одной ячейке Excel: длиннее — библиотека записи бросает исключение, и вся выгрузка ломается. */
export const XLSX_CELL_MAX = 32767;

/** Строки для листа Excel: текст длиннее предела обрезается с многоточием, остальное как есть. */
export function excelSafeRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map(
    (row) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, typeof v === "string" && v.length > XLSX_CELL_MAX ? `${v.slice(0, XLSX_CELL_MAX - 1)}…` : v])
      ) as T
  );
}
