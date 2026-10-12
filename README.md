# Mistral Desktop

Client de bureau **léger, open source et sans télémétrie** pour l'API [Mistral AI](https://mistral.ai), dans l'esprit de Claude Desktop. macOS, Windows et Linux.

> Projet indépendant, non affilié à Mistral AI.

![Capture](docs/screenshot-light.png)

## Fonctionnalités

- Réponses en **streaming**, arrêt à tout moment (bouton ■ ou `Échap`)
- Rendu **Markdown** : tableaux, listes, blocs de code colorés avec bouton « Copier »
- **Raisonnement** des modèles Magistral affiché dans un bloc repliable
- **Images** (modèles vision) et **fichiers texte/code** en pièce jointe : bouton, glisser-déposer ou collage
- Historique local : recherche, renommage, suppression, regroupement par date
- Modifier un message envoyé, régénérer une réponse
- Choix du modèle par conversation (liste récupérée depuis l'API), instructions système, température, tokens max
- **Export Markdown** d'une conversation
- Thème clair / sombre / système
- Raccourcis : `Ctrl/⌘+N` nouvelle conversation, `Ctrl/⌘+K` recherche, `Ctrl/⌘+B` barre latérale, `Ctrl/⌘+,` réglages

## Vie privée et sécurité

| Point | Choix |
|---|---|
| Télémétrie | Aucune. Aucun appel réseau hors de l'URL d'API configurée. |
| Clé API | Stockée dans le **trousseau du système** (Keychain macOS, Credential Manager Windows, Secret Service/KWallet Linux). Repli possible via la variable `MISTRAL_API_KEY`. |
| Appels API | Faits **côté Rust** : la clé n'est jamais exposée à la WebView. |
| Conversations | Fichiers JSON locaux, jamais synchronisés. |
| WebView | CSP stricte (pas de ressource distante, pas d'images externes = pas de pixel de suivi), HTML des réponses assaini par DOMPurify, liens ouverts dans le navigateur du système. |
| Auto-hébergement | URL d'API configurable : fonctionne avec un serveur compatible OpenAI (vLLM, Ollama, llama.cpp…) faisant tourner les modèles open-weight de Mistral sur votre propre machine. HTTP en clair accepté seulement sur `localhost`. |

Données conservées par Mistral côté API : voir leurs [conditions](https://mistral.ai/terms) (hébergement UE, possibilité de désactiver l'entraînement sur vos données depuis la console).

Emplacements locaux :

| OS | Conversations | Réglages |
|---|---|---|
| Linux | `~/.local/share/dev.r0mish.mistral-desktop/` | `~/.config/dev.r0mish.mistral-desktop/` |
| macOS | `~/Library/Application Support/dev.r0mish.mistral-desktop/` | idem |
| Windows | `%APPDATA%\dev.r0mish.mistral-desktop\` | idem |

## Installation

### Binaires

Les installateurs (`.dmg`, `.msi`/`.exe`, `.deb`, `.rpm`, `.AppImage`) sont produits par GitHub Actions à chaque tag `v*` (release en brouillon).

```bash
git tag v0.1.0 && git push origin v0.1.0
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
npm run tauri dev      # développement (rechargement à chaud)
npm run tauri build    # installateurs dans src-tauri/target/release/bundle/
```

## Architecture

```
src/                    Interface (TypeScript, sans framework)
  main.ts               État, rendu, streaming, pièces jointes, réglages
  markdown.ts           marked + highlight.js + DOMPurify
  api.ts                Appels IPC typés vers Rust
src-tauri/src/
  lib.rs                Commandes Tauri, trousseau, annulation des flux
  mistral.rs            Client HTTP (reqwest/rustls), parsing SSE
  storage.rs            Stockage JSON atomique, export Markdown
```

Tauri 2 utilise la WebView native de l'OS (WebKit, WebView2) : binaire d'environ 10 Mo, contre ~150 Mo pour une app Electron.

## Licence

MIT
