/**
 * Разбор свободного текста длительности ("3 дня", "2 часа", "45 минут") в
 * минуты — используется анализом узких мест (М2.1) и расчётом стоимости
 * (М2.2). Понимает только простые формы "число + единица"; более сложные
 * формулировки не распознаются (возвращается null).
 */
const UNIT_MINUTES: Record<string, number> = {
  минут: 1,
  минуту: 1,
  минуты: 1,
  час: 60,
  часа: 60,
  часов: 60,
  день: 1440,
  дня: 1440,
  дней: 1440,
  недел: 10080, // недели/неделю/недель — префикс
};

export function parseDurationToMinutes(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /(\d+(?:[.,]\d+)?)\s*(минут[уы]?|час(?:а|ов)?|д(?:ень|ня|ней)|недел[юяи]?|недель)/iu.exec(text);
  if (!m) return null;
  const value = parseFloat(m[1].replace(",", "."));
  const unitRaw = m[2].toLowerCase();
  const unitKey = Object.keys(UNIT_MINUTES).find((k) => unitRaw.startsWith(k));
  if (!unitKey) return null;
  return value * UNIT_MINUTES[unitKey];
}

export function formatMinutes(minutes: number): string {
  if (minutes >= 1440) return `${(minutes / 1440).toFixed(1)} дн.`;
  if (minutes >= 60) return `${(minutes / 60).toFixed(1)} ч.`;
  return `${minutes.toFixed(0)} мин.`;
}
