// Обходчик метамодели Business Studio 6: классы (.mdm) + русские названия (.ru.resx по GUID).
// Запуск: node pm-bs-metamodel.mjs -> печатает сводку и пишет %TEMP%\pm-bs-metamodel.json
import fs from "node:fs";
import path from "node:path";

const BS = "C:\\Program Files (x86)\\STU-Soft\\Business Studio 6\\Metadata\\1.0.0.5";
const tmp = process.env.TEMP;

function resxDict(file) {
  const t = fs.readFileSync(file, "utf8");
  const d = new Map();
  const re = /<data name="([^"]+)"[^>]*>\s*<value>([\s\S]*?)<\/value>/g;
  let m;
  while ((m = re.exec(t))) d.set(m[1], m[2].replace(/\s+/g, " ").trim());
  return d;
}

/** Классы модуля: блочный обход по строке (вложенность внутри <Class> не мешает — берём начало блока). */
function classesOf(mdm, ru) {
  const t = fs.readFileSync(mdm, "utf8");
  const out = [];
  let i = 0;
  for (;;) {
    const s = t.indexOf("<Class>", i);
    if (s < 0) break;
    const e = t.indexOf("</Class>", s);
    if (e < 0) break;
    const b = t.slice(s, e);
    i = e + 8;
    const id = /<ID>([0-9a-fA-F-]{36})<\/ID>/.exec(b)?.[1];
    const sn = /<SystemName>([A-Za-z][A-Za-z0-9_]*)<\/SystemName>/.exec(b)?.[1];
    if (!id || !sn) continue;
    const blocks = [...b.matchAll(/<(Param|Option)>([\s\S]*?)<\/\1>/g)].map((x) => x[2]);
    const props = blocks
      .map((pb) => ({
        id: /<ID>([0-9a-fA-F-]{36})<\/ID>/.exec(pb)?.[1] ?? null,
        name: /<SystemName>([A-Za-z][A-Za-z0-9_]*)<\/SystemName>/.exec(pb)?.[1] ?? null,
        type: /<Type>([^<]*)<\/Type>/.exec(pb)?.[1] ?? null,
        enum: /<EnumType>([^<]*)<\/EnumType>/.exec(pb)?.[1] ?? null,
        value: /<Value>([^<]*)<\/Value>/.exec(pb)?.[1] ?? null,
      }))
      .filter((p) => p.name || p.value);
    out.push({
      id,
      name: sn,
      ru: ru.get(`${id}#RepositoryView.Header`) ?? ru.get(`${id}#Description`) ?? null,
      desc: ru.get(`${id}#Description`) ?? null,
      props: props.map((p) => ({ ...p, ru: p.id ? (ru.get(`${p.id}#PropertyView.Header`) ?? null) : null })),
    });
  }
  return out;
}

const ru = resxDict(path.join(BS, "BizArch.ru.resx"));
const modules = {};
for (const [file, key] of [["BizArch.mdm", "BizArch"], ["AppPlatform.mdm", "AppPlatform"], ["CRM.mdm", "CRM"]]) {
  const cl = classesOf(path.join(BS, file), key === "BizArch" ? ru : resxDict(path.join(BS, file.replace(".mdm", ".ru.resx"))));
  modules[key] = cl;
}
fs.writeFileSync(path.join(tmp, "pm-bs-metamodel.json"), JSON.stringify(modules, null, 1), "utf8");

const pat = /Idef|Activity|Arrow|FunctionalObject|Diagram|Symbol|Style|Decompos|Route|Influence|Tunnel|Border|Boundary|Comment|Note/;
for (const [mod, cl] of Object.entries(modules)) {
  const withRu = cl.filter((c) => c.ru).length;
  const props = cl.reduce((n, c) => n + c.props.length, 0);
  console.log(`\n=== ${mod}: классов ${cl.length}, с русским именем ${withRu}, элементов свойств/вариантов ${props}`);
  if (mod !== "BizArch") continue;
  console.log("--- срез по IDEF0/диаграммам (класс -> русское имя, свойств) ---");
  for (const c of cl.filter((c) => pat.test(c.name)).slice(0, 28)) {
    console.log(`${c.name.padEnd(38)} ${(c.ru ?? "—").padEnd(34)} свойств ${c.props.length}`);
    for (const p of c.props.slice(0, 4)) console.log(`      · ${(p.ru ?? p.name ?? p.value ?? "").slice(0, 60)}${p.enum ? ` [enum ${p.enum}]` : ""}`);
  }
}
console.log(`\nJSON: ${path.join(tmp, "pm-bs-metamodel.json")}`);
