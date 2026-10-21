// Tests de bout en bout : l'application réelle (Rust + WebView) pilotée par tauri-driver,
// contre un faux serveur Mistral. Données isolées dans un dossier temporaire.
//
//   npx tauri build --debug --no-bundle
//   xvfb-run -a npm run test:e2e        (Linux, avec tauri-driver et WebKitWebDriver)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requests } from "./mock-mistral.mjs";
import { idle, launch, send as sendTo, setValue, step as stepOf } from "./harness.mjs";

let app;
let d;
let workspace;

before(async () => {
  app = await launch(({ root, data }) => {
    workspace = join(root, "projet");
    mkdirSync(join(workspace, "notes"), { recursive: true });
    // Dossier de projet déjà autorisé (la boîte de dialogue native n'est pas pilotable).
    writeFileSync(join(data, "workspaces.json"), JSON.stringify([workspace]));
    writeFileSync(join(workspace, "AGENTS.md"), "# Consignes\n\nToujours respecter RÈGLE-E2E-42.\n");
  });
  d = app.d;
});

after(() => app?.close());

const step = (t, name, fn) => stepOf(t, d, name, fn);
const send = (text) => sendTo(d, text);

test("application de bout en bout", async (t) => {
  await step(t, "démarrage et liste des modèles", async () => {
    await d.waitVisible(".welcome h2");
    await d.waitFor(() => [...document.querySelectorAll("#model-select option")].some((o) => o.value === "modele-e2e-latest"), {
      message: "modèle du faux serveur dans la liste",
    });
  });

  await step(t, "conversation en streaming", async () => {
    await send("Bonjour depuis le test");
    await d.waitText("#messages", "pamplemousse");
    await idle(d);
    const req = requests.at(-1);
    assert.equal(req.auth, "Bearer cle-e2e");
    assert.equal(req.model, "mistral-medium-latest");
    assert.ok(req.stream, "requête en streaming");
    await d.waitText("#conv-list", "Bonjour depuis le test");
    await d.waitText("#activity", "Terminé");
  });

  await step(t, "recherche dans le contenu des conversations", async () => {
    await d.type("#search", "pamplemousse");
    await d.waitFor(() => document.querySelector("#conv-list mark")?.textContent?.toLowerCase() === "pamplemousse", {
      message: "extrait surligné",
    });
    await setValue(d, "#search", "", "input");
  });

  await step(t, "réglages", async () => {
    await d.click("#open-settings");
    await d.waitFor(() => document.querySelector("#settings").open, { message: "réglages ouverts" });
    await d.click('.settings-tabs [data-tab="code"]');
    await d.waitVisible('#settings .tab[data-tab="code"]');
    await d.click("#settings-cancel");
    await d.waitFor(() => !document.querySelector("#settings").open, { message: "réglages fermés" });
  });

  await step(t, "projet : consignes envoyées au modèle", async () => {
    await setValue(d, "#project-select", "__new");
    await d.waitFor(() => document.querySelector("#project-dialog").open, { message: "fenêtre du projet" });
    await d.type("#p-name", "Projet E2E");
    await d.type("#p-instructions", "Respecter CONSIGNE-PROJET-E2E.");
    await d.click("#p-save");
    await d.waitFor(() => !document.querySelector("#project-dialog").open, { message: "projet enregistré" });
    await d.click("#new-chat");
    await d.waitText(".welcome", "Projet E2E");
    await send("PROJET : as-tu les consignes ?");
    await d.waitText("#messages", "Projet reçu : CONSIGNE-PROJET-E2E");
    await idle(d);
  });

  await step(t, "code : AGENTS.md chargé", async () => {
    await d.click('.mode-tabs [data-mode="code"]');
    await d.waitText(".welcome", "Nouvelle session de code");
    await d.click(".welcome [data-ws]");
    await d.waitText(".welcome", "AGENTS.md");
    await send("CONSIGNES : lesquelles ?");
    await d.waitText("#messages", "Consignes reçues : RÈGLE-E2E-42");
    await idle(d);
  });

  await step(t, "code : écriture approuvée", async () => {
    await send("ÉCRIS un fichier de notes");
    await d.waitVisible('[data-approve="allow"]');
    assert.ok(!existsSync(join(workspace, "notes/e2e.txt")), "rien d'écrit avant l'approbation");
    await d.click('[data-approve="allow"]');
    await d.waitText("#messages", "Outil terminé");
    await idle(d);
    assert.equal(readFileSync(join(workspace, "notes/e2e.txt"), "utf8"), "créé par le test e2e\n");
  });

  await step(t, "code : écriture refusée", async () => {
    await send("ÉCRIS encore");
    await d.click('[data-approve="deny"]');
    await d.waitText("#activity", "refusé");
    await idle(d);
  });
});
