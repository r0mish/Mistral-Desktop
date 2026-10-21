// SSH par mot de passe et code 2FA, contre de vrais serveurs sshd (ignoré s'ils ne sont pas configurés) :
//   E2E_SSH_USER, E2E_SSH_PASSWORD, E2E_SSH_PASSWORD_PORT (mot de passe seul),
//   E2E_SSH_2FA_PORT et E2E_SSH_TOTP_SECRET (mot de passe puis code TOTP),
//   E2E_KEYRING=1 si un trousseau (Secret Service) est disponible.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { idle, launch, send, setValue, step as stepOf } from "./harness.mjs";

const cfg = {
  user: process.env.E2E_SSH_USER,
  password: process.env.E2E_SSH_PASSWORD,
  passwordPort: process.env.E2E_SSH_PASSWORD_PORT,
  twoFaPort: process.env.E2E_SSH_2FA_PORT,
  totpSecret: process.env.E2E_SSH_TOTP_SECRET,
};
const skip = !cfg.user || !cfg.password || !cfg.passwordPort ? "serveurs SSH de test non configurés (E2E_SSH_*)" : false;

/** Code TOTP (RFC 6238, SHA-1, 6 chiffres, 30 s). */
function totp(base32) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of base32.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}

let app;
let d;

before(async () => {
  if (skip) return;
  app = await launch(undefined, { keepHome: true });
  d = app.d;
});

after(() => app?.close());

const step = (t, name, fn) => stepOf(t, d, name, fn);
const has2fa = cfg.twoFaPort && cfg.totpSecret;

/** Ferme l'accès aux connexions maîtresses : la prochaine connexion s'authentifie à nouveau. */
function dropMasters() {
  const dir = `/tmp/md-ssh-${process.getuid()}`;
  for (const f of readdirSync(dir)) rmSync(`${dir}/${f}`, { force: true });
}

/**
 * Ouvre la fenêtre des serveurs SSH depuis une nouvelle session de code et remplit le formulaire.
 * Une connexion maîtresse déjà ouverte vers le même hôte serait réutilisée sans nouvelle
 * authentification : les scénarios d'authentification commencent par `dropMasters()`.
 */
async function fillHost({ label, port, password }) {
  // Invite restée ouverte par un scénario précédent en échec.
  if (await d.exec(() => document.querySelector("#ssh-prompt").open)) await d.click("#ssh-prompt-cancel");
  if (!(await d.exec(() => document.querySelector("#ssh-dialog").open))) {
    await d.click('.mode-tabs [data-mode="code"]');
    await d.click(".welcome [data-ssh]");
    await d.waitFor(() => document.querySelector("#ssh-dialog").open, { message: "fenêtre SSH" });
  }
  await d.click("#ssh-new");
  await d.type("#ssh-label", label);
  await d.type("#ssh-host", "127.0.0.1");
  await d.type("#ssh-user", cfg.user);
  await d.type("#ssh-port", String(port));
  await setValue(d, "#ssh-auth", "password");
  if (password) await d.type("#ssh-password", password);
  await d.click("#ssh-test");
  // Hôte inconnu : l'empreinte est montrée, on lui fait confiance.
  await d.waitFor(
    () =>
      document.querySelector("#ssh-trust") ||
      document.querySelector("#ssh-result .ssh-msg.ok, #ssh-result .ssh-msg.error") ||
      document.querySelector("#ssh-prompt").open,
    { timeout: 30000, message: "empreinte, invite ou résultat" },
  );
  if (await d.exec(() => !!document.querySelector("#ssh-trust"))) await d.click("#ssh-trust");
}

/** Répond à l'invite d'authentification affichée par l'application. */
async function answerPrompt(expected, value) {
  await d.waitFor(() => document.querySelector("#ssh-prompt").open, { timeout: 30000, message: "invite SSH" });
  assert.match(await d.text("#ssh-prompt-text"), expected);
  await d.type("#ssh-prompt-input", value);
  await d.click('#ssh-prompt-form button[type="submit"]');
}

/** Connexion réussie, puis lecture des dossiers distants terminée (elle utilise la connexion). */
async function connected() {
  await d.waitText("#ssh-result", `Connecté en tant que ${cfg.user}`, 60000);
  await d.waitFor(
    () => {
      const dirs = document.querySelector("#ssh-dirs");
      return !document.querySelector("#ssh-browser").hidden && !dirs.querySelector(".spinner") && dirs.children.length > 0;
    },
    { timeout: 30000, message: "dossiers distants lus" },
  );
}

test("SSH par mot de passe et 2FA", { skip }, async (t) => {
  await step(t, "mot de passe saisi dans le formulaire", async () => {
    await fillHost({ label: "Mot de passe", port: cfg.passwordPort, password: cfg.password });
    await connected();
    // La connexion est réutilisée : la navigation ne redemande rien.
    assert.equal(await d.exec(() => document.querySelector("#ssh-prompt").open), false, "aucune invite");
  });

  await step(t, "commande de l'agent sur le serveur", async () => {
    await d.click("#ssh-open");
    await d.waitFor(() => !document.querySelector("#ssh-dialog").open, { message: "session ouverte" });
    await send(d, "EXÉCUTE id -un");
    await d.click('[data-approve="allow"]');
    await d.waitText("#messages", "Outil terminé", 30000);
    await idle(d);
    assert.match(await d.text("#messages"), new RegExp(`Code de sortie : 0\\s+${cfg.user}`));
  });

  if (process.env.E2E_KEYRING) {
    await step(t, "reconnexion avec le mot de passe du trousseau", async () => {
      await d.click("#new-chat");
      await d.click(".welcome [data-ssh]");
      await d.waitFor(() => {
        const b = [...document.querySelectorAll("#ssh-host-list [data-host]")].find((x) => x.querySelector("strong")?.textContent === "Mot de passe");
        b?.click();
        return !!b;
      }, { message: "serveur « Mot de passe » dans la liste" });
      await d.waitText("#ssh-title", "Mot de passe");
      await d.waitText("#ssh-password-status", "Mot de passe enregistré");
      dropMasters();
      await d.click("#ssh-test");
      await connected();
      assert.equal(await d.exec(() => document.querySelector("#ssh-prompt").open), false, "aucune invite");
      await d.click("#ssh-close");
    });
  }

  await step(t, "mot de passe refusé puis corrigé", async () => {
    await d.click("#new-chat");
    dropMasters();
    await fillHost({ label: "Mauvais mot de passe", port: cfg.passwordPort, password: "incorrect" });
    await d.waitVisible("#ssh-prompt-retry", 30000);
    await answerPrompt(/password/i, cfg.password);
    await connected();
  });

  if (!has2fa) return t.diagnostic("2FA non testée : E2E_SSH_2FA_PORT et E2E_SSH_TOTP_SECRET absents");

  await step(t, "mot de passe puis code 2FA", async () => {
    await fillHost({ label: "2FA", port: cfg.twoFaPort, password: cfg.password });
    await answerPrompt(/code/i, totp(cfg.totpSecret));
    await connected();
  });

  await step(t, "invite annulée", async () => {
    dropMasters();
    await fillHost({ label: "Annulation", port: cfg.twoFaPort });
    await d.waitFor(() => document.querySelector("#ssh-prompt").open, { timeout: 30000, message: "invite SSH" });
    await d.click("#ssh-prompt-cancel");
    await d.waitText("#ssh-result", "Authentification refusée", 30000);
  });
});
