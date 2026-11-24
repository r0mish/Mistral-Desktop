// Lecture à voix haute des réponses par Voxtral TTS (API Mistral) : texte nettoyé du Markdown,
// découpé en passages, chaque passage suivant étant préparé pendant la lecture du précédent.
import { api } from "./api";
import { errMsg, state } from "./state";
import { toast } from "./ui";

const MAX_CHUNK = 1200;

let current: { msgId: string; audio: HTMLAudioElement | null; stopped: boolean } | null = null;

/** Markdown → texte à prononcer (sans code, liens réduits à leur texte, ni symboles de mise en forme). */
export function speechText(md: string): string {
  return md
    .replace(/```[\s\S]*?(```|$)/g, "\n(bloc de code)\n")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "lien")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, "")
    .replace(/^\s*\|(.*?)\|?\s*$/gm, "$1.")
    .replace(/\s*\|\s*/g, ", ")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|\W)[*_](.+?)[*_](?=\W|$)/g, "$1$2")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ ([.,])/g, "$1")
    .replace(/^ +/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Découpe en passages d'au plus `max` caractères, aux paragraphes puis aux phrases. */
export function chunks(text: string, max = MAX_CHUNK): string[] {
  const out: string[] = [];
  let cur = "";
  const push = (piece: string) => {
    if ((cur + " " + piece).trim().length > max && cur) {
      out.push(cur.trim());
      cur = "";
    }
    cur = `${cur} ${piece}`;
  };
  for (const para of text.split(/\n{2,}/)) {
    const sentences = para.match(/[^.!?…]+[.!?…]*\s*/g) ?? [para];
    for (let s of sentences) {
      while (s.length > max) {
        push(s.slice(0, max));
        s = s.slice(max);
      }
      push(s.trim());
    }
    if (cur.trim()) {
      out.push(cur.trim());
      cur = "";
    }
  }
  return out.filter((c) => /\p{L}|\p{N}/u.test(c));
}

function markButtons() {
  document.querySelectorAll<HTMLElement>('[data-act="speak"]').forEach((b) => {
    const on = b.closest<HTMLElement>(".msg")?.dataset.id === current?.msgId;
    b.classList.toggle("speaking", on);
    b.title = on ? "Arrêter la lecture (Échap)" : "Lire à voix haute (Voxtral)";
  });
}

export const isSpeaking = (msgId: string) => current?.msgId === msgId;

/** Arrête la lecture en cours. Renvoie true s'il y en avait une. */
export function stopSpeech(): boolean {
  if (!current) return false;
  current.stopped = true;
  current.audio?.pause();
  current = null;
  markButtons();
  return true;
}

const synth = async (text: string) => {
  const b64 = await api.speak(text);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
};

function play(url: string, run: NonNullable<typeof current>): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    audio.playbackRate = state.settings.ttsSpeed || 1;
    run.audio = audio;
    const done = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    audio.onended = done;
    audio.onpause = done;
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("lecture audio impossible"));
    };
    audio.play().catch(reject);
  });
}

/** Lit la réponse `msgId` (en arrêtant toute lecture en cours). */
export async function speakMessage(msgId: string, markdown: string) {
  stopSpeech();
  const parts = chunks(speechText(markdown));
  if (!parts.length) return toast("Rien à lire dans cette réponse.", true);
  const run = { msgId, audio: null as HTMLAudioElement | null, stopped: false };
  current = run;
  markButtons();
  try {
    let next = synth(parts[0]);
    for (let i = 0; i < parts.length; i++) {
      const url = await next;
      if (run.stopped) return URL.revokeObjectURL(url);
      // Passage suivant préparé pendant la lecture de celui-ci.
      if (i + 1 < parts.length) next = synth(parts[i + 1]);
      await play(url, run);
      if (run.stopped) return;
    }
  } catch (e) {
    if (!run.stopped) toast(`Lecture à voix haute impossible : ${errMsg(e)}`, true);
  } finally {
    if (current === run) {
      current = null;
      markButtons();
    }
  }
}

/** Bouton « lire » : un second clic sur la même réponse arrête la lecture. */
export function onSpeakClick(msgId: string, markdown: string) {
  if (current?.msgId === msgId) {
    stopSpeech();
    return;
  }
  void speakMessage(msgId, markdown);
}
