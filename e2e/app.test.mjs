// Tests de bout en bout : l'application réelle (Rust + WebView) pilotée par tauri-driver,
// contre un faux serveur Mistral. Données isolées dans un dossier temporaire.
//
//   npm run build && npx tauri build --debug --no-bundle
//   xvfb-run node --test e2e/          (Linux, avec tauri-driver et WebKitWebDriver)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Driver } from "./webdriver.mjs";
import { requests, startMock } from "./mock-mistral.mjs";

const ID = "dev.r0mish.mistral-desktop";
const APP = resolve(process.env.E2E_APP ?? "src-tauri/target/debug/mistral-desktop");
const ARTIFACTS = resolve("e2e/artifacts");
const DRIVER_PORT = 4444;

const root = mkdtempSync(join(tmpdir(), "mistral-e2e-"));
const workspace = join(root, "projet");
let mock;
let tauriDriver;
/** @type {Driver} */
let d;

before(async () => {
  assert.ok(existsSync(APP), `Application introuvable : ${APP} (npx tauri build --debug --no-bundle)`);
  mock = await startMock();
  const env = {
    ...process.env,
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    MISTRAL_API_KEY: "cle-e2e",
  };
  const config = join(env.XDG_CONFIG_HOME, ID);
  const data = join(env.XDG_DATA_HOME, ID);
  for (const dir of [env.HOME, config, data, join(workspace, "notes")]) mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(config, "settings.json"),
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${mock.address().port}`,
      defaultModel: "mistral-medium-latest",
      codeModel: "devstral-medium-latest",
      checkUpdates: false,
      encryptData: false,
      settingsVersion: 1,
    }),
  );
  // Dossier de projet déjà autorisé (la boîte de dialogue native n'est pas pilotable).
  writeFileSync(join(data, "workspaces.json"), JSON.stringify([workspace]));
  writeFileSync(join(workspace, "AGENTS.md"), "# Consignes\n\nToujours respecter RÈGLE-E2E-42.\n");

  // Groupe de processus dédié : WebKitWebDriver et l'app sont arrêtés avec tauri-driver.
  tauriDriver = spawn("tauri-driver", ["--port", String(DRIVER_PORT)], {
    env,
    detached: true,
    stdio: ["ignore", process.env.E2E_VERBOSE ? "inherit" : "ignore", "inherit"],
  });
  const base = `http://127.0.0.1:${DRIVER_PORT}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/status`)).ok) break;
    } catch {}
    if (i > 100) throw new Error("tauri-driver ne répond pas");
    await new Promise((r) => setTimeout(r, 100));
  }
  d = await Driver.create(base, APP);
  await d.waitVisible("#input", 30000);
});

after(async () => {
  await d?.quit();
  if (tauriDriver?.pid) {
    try {
      process.kill(-tauriDriver.pid, "SIGTERM");
    } catch {}
  }
  mock?.close();
});

/** Capture d'écran en cas d'échec, pour l'artefact du CI. */
async function step(t, name, fn) {
  await t.test(name, async () => {
    try {
      await fn();
    } catch (e) {
      mkdirSync(ARTIFACTS, { recursive: true });
      const file = join(ARTIFACTS, `${name.replace(/[^\w-]+/g, "_")}.png`);
      await d.screenshot().then((png) => writeFileSync(file, png)).catch(() => {});
      throw e;
    }
  });
}

/** Saisit un message dans le compositeur et l'envoie. */
async function send(text) {
  await d.type("#input", text);
  await d.click("#send-btn");
}

const idle = () => d.waitFor(() => !document.querySelector("#app").classList.contains("is-streaming"), { message: "fin de génération" });

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
    await idle();
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
    await d.exec(() => {
      const s = document.querySelector("#search");
      s.value = "";
      s.dispatchEvent(new Event("input"));
    });
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
    await d.exec(() => {
      const s = document.querySelector("#project-select");
      s.value = "__new";
      s.dispatchEvent(new Event("change"));
    });
    await d.waitFor(() => document.querySelector("#project-dialog").open, { message: "fenêtre du projet" });
    await d.type("#p-name", "Projet E2E");
    await d.type("#p-instructions", "Respecter CONSIGNE-PROJET-E2E.");
    await d.click("#p-save");
    await d.waitFor(() => !document.querySelector("#project-dialog").open, { message: "projet enregistré" });
    await d.click("#new-chat");
    await d.waitText(".welcome", "Projet E2E");
    await send("PROJET : as-tu les consignes ?");
    await d.waitText("#messages", "Projet reçu : CONSIGNE-PROJET-E2E");
    await idle();
  });

  await step(t, "code : AGENTS.md chargé", async () => {
    await d.click('.mode-tabs [data-mode="code"]');
    await d.waitText(".welcome", "Nouvelle session de code");
    await d.click(".ws-recent [data-ws], .welcome [data-ws]");
    await d.waitText(".welcome", "AGENTS.md");
    await send("CONSIGNES : lesquelles ?");
    await d.waitText("#messages", "Consignes reçues : RÈGLE-E2E-42");
    await idle();
  });

  await step(t, "code : écriture approuvée", async () => {
    await send("ÉCRIS un fichier de notes");
    await d.waitVisible('[data-approve="allow"]');
    assert.ok(!existsSync(join(workspace, "notes/e2e.txt")), "rien d'écrit avant l'approbation");
    await d.click('[data-approve="allow"]');
    await d.waitText("#messages", "Fichier écrit");
    await idle();
    assert.equal(readFileSync(join(workspace, "notes/e2e.txt"), "utf8"), "créé par le test e2e\n");
  });

  await step(t, "code : écriture refusée", async () => {
    await send("ÉCRIS encore");
    await d.click('[data-approve="deny"]');
    await d.waitText("#activity", "refusé");
    await idle();
  });
});
