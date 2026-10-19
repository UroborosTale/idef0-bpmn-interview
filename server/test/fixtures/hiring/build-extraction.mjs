// Сборка ответа извлечения (ExtractionChunkResult) из компактной таблицы:
//   node pm-extract-build.mjs <таблица.mjs> <выход.json>
// Таблица: subs[[имя,цитата]] · ops[[имя,индекс подпроцесса,цитата,[ [вид,имя,subtype,роль,цитата], ... ]]]
//   вид: t задача · e событие · g шлюз;  имя с "-" впереди — не связывать в цепочку (ветка/конец)
//   data[[имя,вид,цитата]] · systems[[имя,цитата]] · controls[[имя,вид,цитата]] · extra[[откуда,куда,условие]]
import fs from "node:fs";

const [src, out] = process.argv.slice(2);
const t = await import("file:///" + src.replace(/\\/g, "/"));
const subs = t.subs ?? [];
const ops = t.ops ?? [];
const extra = t.extra ?? [];

const nodes = [];
const flows = [];
const byName = new Map();
let order = 0;
const sourced = { source_fragment_id: "auto", confidence: 0.8 };

const subprocesses = subs.map(([name, quote]) => ({ name, quote, source_fragment_id: "auto", confidence: 0.55 }));
const operations = [];
for (const [opName, subIdx, opQuote, steps] of ops) {
  operations.push({ name: opName, subprocess_name: subs[subIdx][0], quote: opQuote, source_fragment_id: "auto", confidence: 0.8 });
  const chain = [];
  for (const [kind, rawName, subtype, role, quote] of steps) {
    const branch = rawName.startsWith("-");
    const name = rawName.replace(/^[-!]/, "");
    order += 1;
    nodes.push({
      type: kind === "g" ? "gateway" : kind === "e" ? "event" : "task",
      subtype: kind === "g" ? subtype || "exclusive" : kind === "e" ? subtype || "intermediate" : subtype || "user",
      name,
      operation_name: opName,
      ...(role ? { role_name: role } : {}),
      order_hint: order,
      quote,
      ...sourced,
    });
    byName.set(name, order);
    if (!branch) chain.push(order);
  }
  for (let i = 0; i < chain.length - 1; i++) {
    flows.push({ from_order_hint: chain[i], to_order_hint: chain[i + 1], condition: null, quote: ops.find((o) => o[0] === opName)[2], ...sourced });
  }
}
for (const [from, to, condition] of extra) {
  const a = byName.get(from);
  const b = byName.get(to);
  if (!a || !b) {
    console.error(`extra: не найдено «${!a ? from : to}»`);
    continue;
  }
  flows.push({ from_order_hint: a, to_order_hint: b, condition: condition ?? null, quote: nodes.find((n) => n.order_hint === a).quote, ...sourced });
}

const result = {
  roles: [],
  systems: (t.systems ?? []).map(([name, quote]) => ({ name, quote, ...sourced })),
  data: (t.data ?? []).map(([name, kind, quote]) => ({ name, kind, quote, ...sourced })),
  controls: (t.controls ?? []).map(([name, kind, quote]) => ({ name, kind, quote, ...sourced })),
  subprocesses,
  operations,
  nodes,
  flows,
  statements: [],
  process_hints: t.hints ?? {},
};
fs.writeFileSync(out, JSON.stringify(result, null, 2), "utf-8");
console.log(`узлов ${nodes.length}, связей ${flows.length}, операций ${operations.length}, подпроцессов ${subprocesses.length} -> ${out}`);
