// Pièces jointes du compositeur : images (redimensionnées localement), PDF et fichiers texte.
import { api, type TextFile } from "./api";
import { escapeHtml } from "./markdown";
import { $, el, errMsg, state } from "./state";
import { icons, toast } from "./ui";

const MAX_TEXT_FILE = 512 * 1024;
const MAX_PDF = 50 * 1024 * 1024;
const MAX_IMAGE_SIDE = 2048;

// ---------------------------------------------------------------- pièces jointes

export function renderAttachments() {
  const { images, files } = state.pending;
  el.attachments.innerHTML =
    images.map((src, i) => `<span class="att img"><img src="${src}" alt="" /><button type="button" data-rm="img:${i}" title="Retirer">×</button></span>`).join("") +
    files.map((f, i) => `<span class="att chip">${icons.file}${escapeHtml(f.name)}<button type="button" data-rm="file:${i}" title="Retirer">×</button></span>`).join("");
}

el.attachments.addEventListener("click", (e) => {
  const rm = (e.target as HTMLElement).dataset.rm;
  if (!rm) return;
  const [kind, i] = rm.split(":");
  if (kind === "img") state.pending.images.splice(+i, 1);
  else state.pending.files.splice(+i, 1);
  renderAttachments();
});

const readAsDataUrl = (f: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });

/** Redimensionne localement les grandes images pour limiter le volume envoyé. */
async function imageToDataUrl(file: File): Promise<string> {
  const url = await readAsDataUrl(file);
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
    img.src = url;
  });
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.width, img.height));
  if (scale === 1 && file.size < 4 * 1024 * 1024) return url;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.88);
}

async function addPdf(file: File) {
  if (file.size > MAX_PDF) throw new Error(`trop volumineux (max ${MAX_PDF / 1048576} Mo)`);
  const placeholder: TextFile = { name: `${file.name} (conversion…)`, text: "" };
  state.pending.files.push(placeholder);
  renderAttachments();
  try {
    const b64 = (await readAsDataUrl(file)).split(",")[1];
    const { text, method } = await api.processDocument(file.name, b64);
    if (!text.trim()) throw new Error("aucun texte extrait");
    placeholder.name = method === "ocr" ? `${file.name} (OCR)` : file.name;
    placeholder.text = text;
  } catch (e) {
    state.pending.files.splice(state.pending.files.indexOf(placeholder), 1);
    throw e;
  } finally {
    renderAttachments();
  }
}

async function addFiles(list: Iterable<File>) {
  for (const file of list) {
    try {
      if (/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
        state.pending.images.push(await imageToDataUrl(file));
        renderAttachments();
        continue;
      }
      if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
        await addPdf(file);
        continue;
      }
      if (file.size > MAX_TEXT_FILE) {
        toast(`${file.name} : trop volumineux (max ${MAX_TEXT_FILE / 1024} Ko)`, true);
        continue;
      }
      const buf = new Uint8Array(await file.arrayBuffer());
      if (buf.subarray(0, 8000).includes(0)) {
        toast(`${file.name} : format non pris en charge (images, PDF et fichiers texte uniquement)`, true);
        continue;
      }
      state.pending.files.push({ name: file.name, text: new TextDecoder().decode(buf) });
      renderAttachments();
    } catch (e) {
      toast(`${file.name} : ${errMsg(e)}`, true);
    }
  }
  el.input.focus();
}

$("#attach-btn").addEventListener("click", () => el.fileInput.click());
el.fileInput.addEventListener("change", async () => {
  await addFiles(el.fileInput.files ?? []);
  el.fileInput.value = "";
});
el.input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});

let dragDepth = 0;
const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  el.drop.hidden = false;
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    el.drop.hidden = true;
  }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  el.drop.hidden = true;
  if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
});
