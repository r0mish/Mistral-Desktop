// Client WebDriver (W3C) minimal pour piloter l'app via tauri-driver, sans dépendance.
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

export class Driver {
  constructor(base, session) {
    this.base = base;
    this.session = session;
  }

  static async create(base, application) {
    const res = await call(base, "POST", "/session", {
      capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application } } },
    });
    return new Driver(base, res.sessionId);
  }

  cmd(method, path, body) {
    return call(this.base, method, `/session/${this.session}${path}`, body);
  }

  quit() {
    return this.cmd("DELETE", "").catch(() => {});
  }

  /** Exécute du JavaScript dans la page (les arguments sont sérialisés en JSON). */
  exec(fn, ...args) {
    return this.cmd("POST", "/execute/sync", { script: `return (${fn}).apply(null, arguments)`, args });
  }

  async find(css) {
    const el = await this.cmd("POST", "/element", { using: "css selector", value: css });
    return el[ELEMENT];
  }

  /** Attend qu'une condition (fonction exécutée dans la page) renvoie une valeur vraie. */
  async waitFor(fn, { timeout = 15000, message = String(fn), args = [] } = {}) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try {
        last = await this.exec(fn, ...args);
        if (last) return last;
      } catch (e) {
        last = e;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`Délai dépassé : ${message} (dernier résultat : ${last})`);
  }

  /** Attend un élément visible correspondant au sélecteur. */
  waitVisible(css, timeout) {
    return this.waitFor(
      (sel) => {
        const e = document.querySelector(sel);
        return !!e && !e.closest("[hidden]") && e.getClientRects().length > 0;
      },
      { timeout, message: `élément visible ${css}`, args: [css] },
    );
  }

  async click(css) {
    await this.waitVisible(css);
    await this.cmd("POST", `/element/${await this.find(css)}/click`, {});
  }

  async type(css, text) {
    await this.waitVisible(css);
    await this.cmd("POST", `/element/${await this.find(css)}/value`, { text });
  }

  /** Texte visible de la page (ou d'un élément). */
  text(css = "body") {
    return this.exec((sel) => document.querySelector(sel)?.innerText ?? "", css);
  }

  waitText(css, needle, timeout) {
    return this.waitFor((sel, n) => (document.querySelector(sel)?.innerText ?? "").includes(n), {
      timeout,
      message: `« ${needle} » dans ${css}`,
      args: [css, needle],
    });
  }

  async screenshot() {
    return Buffer.from(await this.cmd("GET", "/screenshot"), "base64");
  }
}

async function call(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.value?.error) {
    throw new Error(`WebDriver ${method} ${path} : ${json.value?.error ?? res.status} ${json.value?.message ?? ""}`);
  }
  return json.value;
}
