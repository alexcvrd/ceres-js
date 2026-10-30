// Node example (Node 18+): ask Ceres from a script or a backend job.
//   node examples/node/ask.mjs "What is the optimal sowing density for sunflower?" en
// Talks to the demo proxy by default (CERES_BASE_URL to change).
import { createCeresClient, CeresError } from "../../src/ceres-client.js";

const [question = "What is the optimal sowing density for sunflower?", lang = "en"] = process.argv.slice(2);
const ceres = createCeresClient({ baseUrl: process.env.CERES_BASE_URL || "http://127.0.0.1:8320/ceres" });
try {
  const r = await ceres.ask(question, { lang });
  console.log(`${r.decision}${r.reasonCode ? ` (${r.reasonCode})` : ""} · ${(r.meta.latencyMs.total / 1000).toFixed(1)} s · ${r.meta.releaseId}`);
  console.log(r.answer);
  for (const c of r.citations) console.log(`  [${c.number}] ${c.passage?.sectionId}: "${c.quote}"`);
  for (const m of r.missingInformation) console.log(`  missing: ${m}`);
} catch (e) {
  console.error(e instanceof CeresError ? `${e.kind}: ${e.message}` : e);
  process.exitCode = 1;
}
