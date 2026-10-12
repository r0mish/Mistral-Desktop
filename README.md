# Mistral Desktop

Client de bureau **léger, open source et sans télémétrie** pour l'API [Mistral AI](https://mistral.ai), dans l'esprit de Claude Desktop : chat, **agent de code**, **recherche web**, **PDF** et **serveurs MCP**. macOS, Windows et Linux.

> Projet indépendant, non affilié à Mistral AI.

![Chat](docs/screenshot-light.png)

## Fonctionnalités

### Chat
- Réponses en **streaming**, arrêt à tout moment (bouton ■ ou `Échap`)
- Rendu **Markdown** : tableaux, listes, blocs de code colorés avec bouton « Copier »
- **Raisonnement** des modèles Magistral dans un bloc repliable
- Pièces jointes : **images** (modèles vision), **PDF** et **fichiers texte/code**, par bouton, glisser-déposer ou collage
- Historique local : recherche, renommage, suppression, regroupement par date ; modifier un message, régénérer une réponse
- Choix du modèle par conversation, instructions système, température, tokens max, **export Markdown**

### Recherche web
Bascule **Web** dans la zone de saisie. Le modèle dispose alors de `web_search` et `fetch_url` et cite ses sources.
- Fournisseur **Mistral** (connecteur `web_search` de l'API Conversations) ou **SearXNG** auto-hébergé
- `fetch_url` lit les pages depuis votre machine ; les adresses du réseau local (routeur, NAS, 10.x, 192.168.x…) sont **bloquées** pour éviter qu'une page piégée ne fasse sonder votre LAN au modèle

### PDF
- **Auto** (défaut) : extraction locale du texte ; bascule sur l'**OCR Mistral** (`mistral-ocr-latest`) seulement si le PDF est scanné
- **Locale** uniquement (rien n'est envoyé pour la conversion) ou **OCR** systématique (tableaux, mises en page complexes)

### Agent de code (onglet **Code**)

![Code](docs/screenshot-code.png)

Un agent façon Claude Code, propulsé par Devstral, travaille dans un dossier de votre machine :
- Outils : `list_files`, `read_file`, `search_files` (regex, respecte `.gitignore`), `edit_file` (remplacement exact), `write_file`, `run_command`
- **Diff coloré** avant chaque modification, approbation commande par commande
- Trois niveaux de permission par session : **Tout demander**, **Modifs auto** (les commandes restent soumises à approbation), **Autonome**
- Accès **confiné au dossier choisi** via la boîte de dialogue native (chemins `..`, absolus et liens symboliques vers l'extérieur refusés)
- Commandes non interactives, avec délai max configurable ; l'arrêt tue tout le groupe de processus

### Serveurs MCP

![MCP](docs/screenshot-mcp.png)

Configuration au **format de Claude Desktop** (Réglages → MCP) :

```json
{
  "mcpServers": {
    "fichiers": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/moi/Documents"]
    },
    "distant": {
      "url": "https://mcp.example.org/mcp",
      "headers": { "Authorization": "Bearer JETON" }
    }
  }
}
```

- Transports **stdio** et **Streamable HTTP**
- Protocole **MCP 2026-07-28** (sans état) avec **repli automatique** sur la poignée de main `initialize` pour les serveurs plus anciens (≤ 2025-11-25)
- Chaque appel demande votre accord, avec « Toujours autoriser cet outil » ; bascule **MCP** pour désactiver les outils dans une conversation
- Sous macOS/Linux, le `PATH` de votre shell est récupéré au démarrage (Homebrew, nvm, `~/.local/bin`…)
- Non pris en charge : authentification OAuth des serveurs distants (utilisez un en-tête `Authorization`), sampling, elicitation

### Raccourcis
`Ctrl/⌘+N` nouvelle conversation · `Ctrl/⌘+1` / `2` Chat / Code · `Ctrl/⌘+K` recherche · `Ctrl/⌘+B` barre latérale · `Ctrl/⌘+,` réglages · `Échap` arrêter

## Vie privée et sécurité

| Point | Choix |
|---|---|
| Télémétrie | Aucune. |
| Clé API | **Trousseau du système** (Keychain, Credential Manager, Secret Service/KWallet). Repli : variable `MISTRAL_API_KEY`. |
| Appels réseau | Faits **côté Rust** ; la clé n'est jamais exposée à la WebView. Destinations : l'URL d'API configurée, l'instance SearXNG éventuelle, les pages lues par `fetch_url`, vos serveurs MCP. |
| Conversations | Fichiers JSON locaux, jamais synchronisés. |
| WebView | CSP stricte (aucune ressource distante, donc aucun pixel de suivi), HTML assaini par DOMPurify, liens ouverts dans le navigateur du système. |
| Agent de code | Dossiers autorisés uniquement via la boîte de dialogue native ; écritures et commandes soumises à approbation par défaut. ⚠️ En mode **Autonome**, les commandes s'exécutent avec vos droits sans confirmation : à réserver aux projets de confiance (le contenu lu sur le web ou dans le dépôt peut tenter d'influencer le modèle). |
| MCP | `mcp.json` est stocké en clair dans le dossier de configuration : évitez d'y mettre des secrets sensibles, ou préférez des serveurs locaux. |
| Auto-hébergement | URL d'API configurable : compatible avec un serveur OpenAI-like (vLLM, Ollama, llama.cpp…) servant les modèles open-weight de Mistral. HTTP en clair accepté seulement sur `localhost`. La recherche web via Mistral et l'OCR nécessitent l'API Mistral ; utilisez SearXNG et l'extraction PDF locale pour un fonctionnement 100 % local. |

Emplacements locaux :

| OS | Données (conversations, dossiers autorisés) | Réglages (`settings.json`, `mcp.json`) |
|---|---|---|
| Linux | `~/.local/share/dev.r0mish.mistral-desktop/` | `~/.config/dev.r0mish.mistral-desktop/` |
| macOS | `~/Library/Application Support/dev.r0mish.mistral-desktop/` | idem |
| Windows | `%APPDATA%\dev.r0mish.mistral-desktop\` | idem |

## Installation

### Binaires

Les installateurs (`.dmg`, `.msi`/`.exe`, `.deb`, `.rpm`, `.AppImage`) sont produits par GitHub Actions à chaque tag `v*` (release en brouillon) :

```bash
git tag v0.2.0 && git push origin v0.2.0
```

Les binaires ne sont pas signés :
- **macOS** : `xattr -cr "/Applications/Mistral Desktop.app"` au premier lancement
- **Windows** : SmartScreen → « Informations complémentaires » → « Exécuter quand même »

### Compilation

Prérequis : [Rust](https://rustup.rs) stable, Node.js ≥ 20, et sous Linux :

```bash
# Debian / Ubuntu
sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev build-essential
# Fedora
sudo dnf install webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel openssl-devel
```

```bash
npm ci
npm run tauri dev      # développement
npm run tauri build    # installateurs dans src-tauri/target/release/bundle/
```

## Architecture

```
src/                    Interface (TypeScript, sans framework)
  main.ts               État, rendu, boucle d'agent, pièces jointes, réglages
  agent.ts              Invites système, conversion API, politique d'approbation, cartes d'outils
  markdown.ts           marked + highlight.js + DOMPurify
  api.ts                Appels IPC typés vers Rust
src-tauri/src/
  lib.rs                Commandes Tauri, trousseau, annulation, PDF
  mistral.rs            Client HTTP : chat en streaming + appels d'outils, recherche web, OCR
  tools.rs              Registre des outils et exécution
  workspace.rs          Outils de code confinés au dossier de projet
  web.rs                SearXNG, lecture de pages (protection réseau local)
  mcp.rs                Client MCP stdio / HTTP, double génération de protocole
  storage.rs            Stockage JSON atomique, export Markdown
```

Tauri 2 utilise la WebView native de l'OS (WebKit, WebView2) : binaire d'environ 10-15 Mo, contre ~150 Mo pour une app Electron.

## Licence

MIT
