// Mises à jour : bandeau, installation signée en un clic, vérification périodique.
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "./api";
import { escapeHtml } from "./markdown";
import { $, el, errMsg, state } from "./state";
import { toast } from "./ui";

// ---------------------------------------------------------------- mises à jour

/** Installation automatique possible (build signé, type d'installation compatible). */
let updaterSupported = false;
let installing = false;
const updateStatus = () => $("#update-status");

function renderUpdateBanner() {
  const u = state.update;
  if (!u?.available || u.latest === state.settings.skippedVersion) {
    el.updateBanner.hidden = true;
    return;
  }
  el.updateBanner.innerHTML = `<span>🎉 <strong>Mistral Desktop ${escapeHtml(u.latest)}</strong> est disponible (vous avez ${escapeHtml(u.current)}).</span>
    <span class="row">
      ${updaterSupported
        ? `<button type="button" class="btn-primary sm" data-upd="install">Installer et redémarrer</button>`
        : `<button type="button" class="btn-primary sm" data-upd="download">${u.assetName ? `Télécharger ${escapeHtml(u.assetName.replace(/^.*\./, "."))}` : "Télécharger"}</button>`}
      <button type="button" class="btn-ghost sm" data-upd="notes">Nouveautés</button>
      <button type="button" class="btn-ghost sm" data-upd="skip">Ignorer cette version</button>
      <button type="button" class="icon-btn sm" data-upd="close" title="Fermer">×</button>
    </span>`;
  el.updateBanner.hidden = false;
}

el.updateBanner.addEventListener("click", (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>("[data-upd]")?.dataset.upd;
  const u = state.update;
  if (!action || !u) return;
  if (action === "download") openUrl(u.assetUrl ?? u.releaseUrl).catch((err) => toast(errMsg(err), true));
  if (action === "install") installUpdate();
  if (action === "notes") openUrl(u.releaseUrl).catch((err) => toast(errMsg(err), true));
  if (action === "skip") {
    state.settings.skippedVersion = u.latest;
    api.saveSettings(state.settings).catch(() => {});
  }
  if (action === "skip" || action === "close") el.updateBanner.hidden = true;
});

/** Télécharge, vérifie la signature, installe puis redémarre (géré côté Rust). */
async function installUpdate() {
  if (installing) return;
  if (state.busy) {
    toast("Attendez la fin de la tâche en cours avant d'installer la mise à jour.", true);
    return;
  }
  installing = true;
  const btn = el.updateBanner.querySelector<HTMLButtonElement>('[data-upd="install"]');
  if (btn) btn.disabled = true;
  try {
    await api.installUpdate(({ done, total }) => {
      if (btn) btn.textContent = total ? `Téléchargement ${Math.round((done / total) * 100)} %` : `Téléchargement ${(done / 1048576).toFixed(1)} Mo`;
    });
  } catch (e) {
    toast(errMsg(e), true);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Installer et redémarrer";
    }
  } finally {
    installing = false;
  }
}

async function checkUpdate(manual = false) {
  try {
    state.update = await api.checkUpdate();
    const u = state.update;
    updateStatus().textContent = u.available
      ? `Version ${u.latest} disponible (installée : ${u.current}).`
      : `À jour (version ${u.current}).`;
    if (manual && u.available && u.latest === state.settings.skippedVersion) {
      state.settings.skippedVersion = "";
    }
    renderUpdateBanner();
  } catch (e) {
    updateStatus().textContent = `Vérification impossible : ${errMsg(e)}`;
    if (manual) toast(`Vérification impossible : ${errMsg(e)}`, true);
  }
}
$("#check-update").addEventListener("click", () => checkUpdate(true));

/** Au démarrage : installation possible ? puis vérification, et toutes les 6 h. */
export async function initUpdates() {
  updaterSupported = await api.updaterSupported().catch(() => false);
  if (state.settings.checkUpdates) {
    checkUpdate();
    window.setInterval(() => state.settings.checkUpdates && checkUpdate(), 6 * 3600 * 1000);
  }
}
