/** Вложенные кавычки: внутри «ёлочек» используем „лапки“, чтобы не было двойных закрывающих «»». */
export function innerQuotes(text: string): string {
  return String(text).replace(/«/g, "„").replace(/»/g, "“");
}

/** Текст в «ёлочках» с корректными вложенными кавычками. */
export function quoted(text: string): string {
  return `«${innerQuotes(text)}»`;
}
