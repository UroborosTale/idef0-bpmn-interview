import type JSZip from "jszip";

/**
 * Безопасное чтение загруженных архивов (.vsdx, .xlsx). Небольшой файл может распаковываться в сотни мегабайт («архив-бомба»):
 * чтение целиком и разбор такого XML занимают гигабайты памяти и минуты, а при ещё большем размере роняют процесс сервера.
 * Поэтому каждая часть читается потоком с жёстким пределом, а заявленный в заголовке размер дополнительно проверяется заранее
 * (заголовку не верим: предел действует и при заниженном размере).
 */
export const ZIP_ENTRY_LIMIT = 20 * 1024 * 1024; // одна часть пакета: страница Visio, лист Excel
export const ZIP_TOTAL_LIMIT = 60 * 1024 * 1024; // все прочитанные части вместе

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} МБ`;
const tooBig = (name: string, limit: number) =>
  new Error(`Файл слишком большой после распаковки: часть «${name}» больше ${mb(limit)}. Такие файлы не принимаются — разбейте схему на несколько файлов.`);

/** Читатель частей архива с общим бюджетом: прочитанное суммируется, предел на часть и на весь файл. */
export function zipReader(zip: JSZip, opts: { entry?: number; total?: number } = {}) {
  const entryLimit = opts.entry ?? ZIP_ENTRY_LIMIT;
  const totalLimit = opts.total ?? ZIP_TOTAL_LIMIT;
  let used = 0;
  return (name: string): Promise<string | null> => {
    const file = zip.file(name);
    if (!file) return Promise.resolve(null);
    const declared = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (typeof declared === "number" && declared > entryLimit) return Promise.reject(tooBig(name, entryLimit));
    return new Promise<string | null>((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      let finished = false;
      const fail = (e: Error) => {
        if (finished) return;
        finished = true;
        reject(e);
      };
      const stream = (file as unknown as { internalStream: (type: string) => { on: (ev: string, cb: (a?: any) => void) => any; pause: () => void; resume: () => void } }).internalStream("uint8array");
      stream
        .on("data", (chunk: Uint8Array) => {
          if (finished) return;
          size += chunk.length;
          if (size > entryLimit) {
            stream.pause(); // дальше не распаковываем
            return fail(tooBig(name, entryLimit));
          }
          if (used + size > totalLimit) {
            stream.pause();
            return fail(tooBig(name, totalLimit));
          }
          chunks.push(chunk);
        })
        .on("error", (e: Error) => fail(e))
        .on("end", () => {
          if (finished) return;
          finished = true;
          used += size;
          resolve(Buffer.concat(chunks).toString("utf8"));
        })
        .resume();
    });
  };
}
