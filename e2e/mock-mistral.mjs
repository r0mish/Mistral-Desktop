// Faux serveur de l'API Mistral pour les tests de bout en bout : modèles, chat en streaming
// (SSE) et transcription. Réponses déterministes selon le dernier message utilisateur.
import { createServer } from "node:http";

/** Requêtes reçues, pour les vérifications des tests. */
export const requests = [];

const MODELS = ["mistral-medium-latest", "devstral-medium-latest", "modele-e2e-latest"];

const lastUser = (messages) => [...messages].reverse().find((m) => m.role === "user");
const text = (c) => (typeof c === "string" ? c : (c ?? []).map((p) => p.text ?? "").join(""));

/** Réponse scénarisée : texte, ou appel d'outil puis texte une fois le résultat reçu. */
function script(req) {
  const msgs = req.messages;
  const last = msgs[msgs.length - 1];
  const system = text(msgs.find((m) => m.role === "system")?.content);
  const ask = text(lastUser(msgs)?.content);
  if (last.role === "tool") {
    return { content: `Outil terminé. Résultat : ${text(last.content).slice(0, 200)}` };
  }
  const run = ask.match(/EXÉCUTE (.+)/);
  if (run) return { toolCalls: [{ name: "run_command", arguments: { command: run[1] } }] };
  if (ask.includes("ÉCRIS")) {
    return { toolCalls: [{ name: "write_file", arguments: { path: "notes/e2e.txt", content: "créé par le test e2e\n" } }] };
  }
  if (ask.includes("CONSIGNES")) {
    return { content: system.includes("RÈGLE-E2E-42") ? "Consignes reçues : RÈGLE-E2E-42" : "Consignes absentes" };
  }
  if (ask.includes("PROJET")) {
    return { content: system.includes("CONSIGNE-PROJET-E2E") ? "Projet reçu : CONSIGNE-PROJET-E2E" : "Projet absent" };
  }
  return { content: `Réponse simulée à : ${ask.slice(0, 60)}. Le mot témoin est **pamplemousse**.` };
}

function sse(res, chunks) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end("data: [DONE]\n\n");
}

function chat(req, res) {
  const out = script(req);
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
  if (out.toolCalls) {
    const tool_calls = out.toolCalls.map((t, i) => ({
      id: `call${Date.now() % 1e6}${i}`.slice(0, 9).padEnd(9, "0"),
      type: "function",
      index: i,
      function: { name: t.name, arguments: JSON.stringify(t.arguments) },
    }));
    return sse(res, [{ choices: [{ index: 0, delta: { role: "assistant", content: "", tool_calls }, finish_reason: "tool_calls" }], usage }]);
  }
  const parts = out.content.match(/.{1,16}/gsu) ?? [""];
  sse(res, [
    ...parts.map((p) => ({ choices: [{ index: 0, delta: { content: p }, finish_reason: null }] })),
    { choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }], usage },
  ]);
}

export function startMock(port = 0) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const json = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "GET" && req.url === "/v1/models") {
        return json(200, {
          data: MODELS.map((id) => ({ id, capabilities: { completion_chat: true, function_calling: true, vision: id.startsWith("mistral-medium") }, max_context_length: 128000 })),
        });
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const parsed = JSON.parse(body);
        requests.push({ auth: req.headers.authorization, ...parsed });
        return chat(parsed, res);
      }
      if (req.method === "POST" && req.url === "/v1/audio/transcriptions") {
        return json(200, { text: "Dictée simulée", language: "fr" });
      }
      json(404, { message: `inconnu : ${req.method} ${req.url}` });
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

// Lancement direct : `node e2e/mock-mistral.mjs 8765` (tests manuels).
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startMock(Number(process.argv[2] ?? 8765));
  console.log(`Faux serveur Mistral sur http://127.0.0.1:${server.address().port}`);
}
