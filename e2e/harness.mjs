// Lancement de l'application pour les tests : données isolées, faux serveur Mistral, tauri-driver.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Driver } from "./webdriver.mjs";
import { startMock } from "./mock-mistral.mjs";

const ID = "dev.r0mish.mistral-desktop";
const APP = resolve(process.env.E2E_APP ?? "src-tauri/target/debug/mistral-desktop");
const ARTIFACTS = resolve("e2e/artifacts");
const DRIVER_PORT = 4444;

/**
 * Démarre l'application. `prepare(dirs)` peut écrire des fichiers avant le lancement
 * (dossiers de projet, workspaces.json…). `keepHome` : garder le vrai dossier personnel
 * (ssh lit ~/.ssh/known_hosts dans le dossier du compte, pas dans $HOME).
 */
export async function launch(prepare = () => {}, { keepHome = false } = {}) {
  if (!existsSync(APP)) throw new Error(`Application introuvable : ${APP} (npx tauri build --debug --no-bundle)`);
  const root = mkdtempSync(join(tmpdir(), "mistral-e2e-"));
  const mock = await startMock();
  const env = {
    ...process.env,
    HOME: keepHome ? process.env.HOME : join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    MISTRAL_API_KEY: "cle-e2e",
  };
  const dirs = { root, config: join(env.XDG_CONFIG_HOME, ID), data: join(env.XDG_DATA_HOME, ID) };
  for (const dir of [env.HOME, dirs.config, dirs.data]) mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dirs.config, "settings.json"),
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${mock.address().port}`,
      defaultModel: "mistral-medium-latest",
      codeModel: "devstral-medium-latest",
      checkUpdates: false,
      encryptData: false,
      settingsVersion: 1,
    }),
  );
  await prepare(dirs);

  // Groupe de processus dédié : WebKitWebDriver et l'app sont arrêtés avec tauri-driver.
  const tauriDriver = spawn("tauri-driver", ["--port", String(DRIVER_PORT)], {
    env,
    detached: true,
    stdio: ["ignore", process.env.E2E_VERBOSE ? "inherit" : "ignore", "inherit"],
  });
  const close = async (d) => {
    await d?.quit();
    try {
      process.kill(-tauriDriver.pid, "SIGTERM");
    } catch {}
    mock.close();
  };
  const base = `http://127.0.0.1:${DRIVER_PORT}`;
  try {
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${base}/status`)).ok) break;
      } catch {}
      if (i > 100) throw new Error("tauri-driver ne répond pas");
      await new Promise((r) => setTimeout(r, 100));
    }
    const d = await Driver.create(base, APP);
    await d.waitVisible("#input", 30000);
    return { d, dirs, close: () => close(d) };
  } catch (e) {
    await close();
    throw e;
  }
}

/** Sous-test avec capture d'écran en cas d'échec (artefact du CI). */
export async function step(t, d, name, fn) {
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
export async function send(d, text) {
  await d.type("#input", text);
  await d.click("#send-btn");
}

/** Attend la fin de la génération en cours. */
export const idle = (d) =>
  d.waitFor(() => !document.querySelector("#app").classList.contains("is-streaming"), { message: "fin de génération" });

/** Change la valeur d'un <select> (ou d'un champ) et déclenche l'événement attendu par l'interface. */
export const setValue = (d, css, value, event = "change") =>
  d.exec(
    (sel, v, ev) => {
      const e = document.querySelector(sel);
      e.value = v;
      e.dispatchEvent(new Event(ev));
    },
    css,
    value,
    event,
  );
