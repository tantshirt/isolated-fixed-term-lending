// Generates ZenLo illustrations with Kie GPT Image 2.5 (Sunburst).
// Prompts follow ~/Desktop/VIDEOS/manticore/brand/prompt-craft/gpt-image.md.
// Usage: node scripts/generate-art.mjs ../docs/brand/zenlo-prompts.json [name ...]
// An entry with `references` (repo-relative image paths) is uploaded to Kie
// and generated image-to-image; `background` may be "transparent".
// Reads KIE_API_KEY from .env.local; never prints it. Stops above MAX_CREDITS.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const MODEL = "gpt-image-2-5-sunburst-text-to-image";
const EDIT_MODEL = "gpt-image-2-5-sunburst-image-to-image";
const MAX_CREDITS = 100; // about $0.50 at Kie's 2K pricing
const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const KEY = process.env.KIE_API_KEY || env.KIE_API_KEY;
if (!KEY) throw new Error("Set KIE_API_KEY in app/.env.local");
const auth = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const only = process.argv.slice(3);
const prompts = JSON.parse(readFileSync(process.argv[2], "utf8")).filter((p) => !only.length || only.includes(p.name));
const receiptsFile = new URL("../../docs/brand/generation-receipts.json", import.meta.url);
const receipts = JSON.parse(readFileSync(receiptsFile, "utf8"));
mkdirSync(new URL("../../docs/brand/originals/", import.meta.url), { recursive: true });

let spent = 0;
const uploaded = new Map();
// Kie keeps uploads for 24 hours; one upload per reference per run.
async function upload(path) {
  if (uploaded.has(path)) return uploaded.get(path);
  const form = new FormData();
  const file = new URL(`../../${path}`, import.meta.url);
  form.append("file", new Blob([readFileSync(file)]), path.split("/").pop());
  form.append("uploadPath", "zenlo");
  const res = await (
    await fetch("https://kieai.redpandaai.co/api/file-stream-upload", {
      method: "POST",
      headers: { Authorization: auth.Authorization },
      body: form,
    })
  ).json();
  const url = res.data?.downloadUrl ?? res.data?.fileUrl;
  if (!url) throw new Error(`upload ${path}: ${res.msg}`);
  uploaded.set(path, url);
  return url;
}
const webp = (p, png) =>
  sharp(png)
    .resize({ width: p.width ?? (p.aspect_ratio === "3:2" ? 1600 : 1200) })
    .webp({ quality: 78 })
    .toFile(fileURLToPath(new URL(`../public/illustrations/${p.name}.webp`, import.meta.url)));

for (const p of prompts) {
  if (spent >= MAX_CREDITS) throw new Error("Credit cap reached");
  const original = new URL(`../../docs/brand/originals/${p.name}.png`, import.meta.url);
  // Never pay twice: an existing original is only converted.
  if (existsSync(original)) {
    await webp(p, readFileSync(original));
    console.log(`${p.name}: reused original`);
    continue;
  }
  const refs = p.references?.length ? await Promise.all(p.references.map(upload)) : null;
  const model = refs ? EDIT_MODEL : MODEL;
  const input = { prompt: p.prompt, aspect_ratio: p.aspect_ratio, resolution: "2K", background: p.background ?? "opaque" };
  if (refs) input.input_urls = refs;
  const create = await (
    await fetch("https://api.kie.ai/api/v1/jobs/createTask", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model, input }),
    })
  ).json();
  if (create.code !== 200) throw new Error(`${p.name}: ${create.msg}`);
  const taskId = create.data.taskId;
  let info;
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    info = (await (await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`, { headers: auth })).json()).data;
    if (info.state === "success" || info.state === "fail") break;
  }
  if (info.state !== "success") throw new Error(`${p.name}: ${info.state} ${info.failMsg ?? ""}`);
  const url = JSON.parse(info.resultJson).resultUrls[0];
  const png = Buffer.from(await (await fetch(url)).arrayBuffer());
  writeFileSync(original, png);
  await webp(p, png);
  spent += info.creditsConsumed ?? 10;
  receipts.push({ name: p.name, taskId, creditsConsumed: info.creditsConsumed, model });
  writeFileSync(receiptsFile, JSON.stringify(receipts, null, 2) + "\n");
  console.log(`${p.name}: ok (${info.creditsConsumed} credits)`);
}
console.log(`total credits: ${spent}`);
