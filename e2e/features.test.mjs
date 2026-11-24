// Tests de bout en bout des fonctionnalités de personnalisation : conversation temporaire,
// Top P et graine, mémoire persistante, assistants, lecture à voix haute et réglages du bureau.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { requests, speechRequests } from "./mock-mistral.mjs";
import { idle, launch, send as sendTo, setValue, step as stepOf } from "./harness.mjs";

let app;
let d;

before(async () => {
  app = await launch();
  d = app.d;
});

after(() => app?.close());

const step = (t, name, fn) => stepOf(t, d, name, fn);
const send = (text) => sendTo(d, text);
const convFiles = () => {
  const dir = join(app.dirs.data, "conversations");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json") : [];
};
const openSettings = async (tab) => {
  await d.click("#open-settings");
  await d.waitFor(() => document.querySelector("#settings").open, { message: "réglages ouverts" });
  await d.click(`.settings-tabs [data-tab="${tab}"]`);
  await d.waitVisible(`#settings .tab[data-tab="${tab}"]`);
};
const saveSettings = async () => {
  await d.click("#settings-save");
  await d.waitFor(() => !document.querySelector("#settings").open, { message: "réglages enregistrés" });
};

test("fonctionnalités de personnalisation", async (t) => {
  await step(t, "Top P et graine transmis à l'API", async () => {
    await d.waitVisible(".welcome h2");
    await openSettings("general");
    await setValue(d, "#s-top-p", "0.9", "input");
    await setValue(d, "#s-seed", "42", "input");
    await saveSettings();
    await send("Bonjour avec graine");
    await d.waitText("#messages", "pamplemousse");
    await idle(d);
    const req = requests.at(-1);
    assert.equal(req.top_p, 0.9);
    // Serveur non Mistral (faux serveur local) : paramètre OpenAI « seed ».
    assert.equal(req.seed, 42);
  });

  await step(t, "conversation temporaire jamais enregistrée", async () => {
    const before = convFiles().length;
    await d.click("#new-chat");
    await d.click("#temp-toggle");
    await d.waitVisible("#temp-badge");
    await send("Secret temporaire TEMPO-E2E");
    await d.waitText("#messages", "TEMPO-E2E");
    await idle(d);
    assert.equal(convFiles().length, before, "aucun fichier de conversation créé");
    const listed = await d.exec(() => document.querySelector("#conv-list").textContent);
    assert.ok(!listed.includes("TEMPO-E2E"), "absente de l'historique");
    assert.ok(await d.exec(() => document.querySelector("#export-btn").hidden), "pas d'export");
    await d.click("#new-chat");
    await d.waitFor(() => document.querySelector("#temp-badge").hidden, { message: "nouvelle conversation normale" });
  });

  await step(t, "mémoire persistante jointe aux conversations", async () => {
    await openSettings("personal");
    await d.click("#s-memory");
    await d.type("#mem-input", "Le mot de passe du jeu est ZÈBRE-42.");
    await d.click("#mem-add");
    await d.waitText("#mem-list", "ZÈBRE-42");
    await saveSettings();
    await send("MÉMOIRE : que sais-tu ?");
    await d.waitText("#messages", "Mémoire reçue : ZÈBRE-42");
    await idle(d);
    const tools = requests.at(-1).tools.map((x) => x.function.name);
    assert.ok(tools.includes("remember"), "outil remember proposé");
  });

  await step(t, "outil remember", async () => {
    await send("SOUVIENS-toi de ma boisson");
    await d.waitText("#messages", "Mémorisé");
    await idle(d);
    const mem = JSON.parse(readFileSync(join(app.dirs.data, "memory.json"), "utf8"));
    assert.ok(mem.some((m) => m.text.includes("thé vert")), JSON.stringify(mem));
  });

  await step(t, "mémoire absente d'une conversation temporaire", async () => {
    await d.click("#new-chat");
    await d.click("#temp-toggle");
    await send("MÉMOIRE en temporaire");
    await d.waitText("#messages", "Mémoire absente");
    await idle(d);
    await d.click("#new-chat");
  });

  await step(t, "assistant réutilisable", async () => {
    await openSettings("personal");
    await d.click("#as-new");
    await d.type("#as-name", "Traducteur E2E");
    await setValue(d, "#as-model", "modele-e2e-latest");
    await d.type("#as-instructions", "Respecter CONSIGNE-ASSISTANT-E2E.");
    await d.click("#as-save");
    await d.waitText("#as-list", "Traducteur E2E");
    await d.click("#settings-cancel");
    await d.exec(() => {
      const s = document.querySelector("#assistant-select");
      s.value = [...s.options].find((o) => o.textContent === "Traducteur E2E").value;
      s.dispatchEvent(new Event("change"));
    });
    await send("ASSISTANT : consignes ?");
    await d.waitText("#messages", "Assistant reçu : CONSIGNE-ASSISTANT-E2E");
    await idle(d);
    assert.equal(requests.at(-1).model, "modele-e2e-latest");
    await d.waitText("#assistant-chip", "Traducteur E2E");
  });

  await step(t, "lecture à voix haute (Voxtral TTS)", async () => {
    const n = speechRequests.length;
    await d.click('.msg.assistant:last-of-type [data-act="speak"]');
    for (let i = 0; i < 100 && speechRequests.length === n; i++) await new Promise((r) => setTimeout(r, 100));
    const req = speechRequests.at(-1);
    assert.ok(req, "requête de synthèse vocale envoyée");
    assert.equal(req.model, "voxtral-mini-tts-3-0");
    assert.equal(req.voice_id, "fr_marie_neutral");
    assert.equal(req.auth, "Bearer cle-e2e");
    assert.ok(req.input.includes("CONSIGNE-ASSISTANT-E2E") && !req.input.includes("**"), req.input);
    await d.exec(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  });

  await step(t, "raccourci global invalide refusé", async () => {
    await openSettings("general");
    await setValue(d, "#s-shortcut", "Ctrl+Truc+", "input");
    await d.click("#settings-save");
    await d.waitText("#settings-error", "Raccourci global invalide");
    await setValue(d, "#s-shortcut", "", "input");
    await saveSettings();
  });
});
