//! Intégration au bureau : icône dans la barre système (zone de notification) et raccourci
//! clavier global pour ouvrir une nouvelle conversation depuis n'importe quelle application.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const TRAY_ID: &str = "main";

/// Affiche, restaure et met au premier plan la fenêtre principale.
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Fenêtre au premier plan puis action de l'interface : « new » ou « temporary ».
fn open_with(app: &AppHandle, action: &str) {
    show_main(app);
    let _ = app.emit("desktop-action", action);
}

pub fn create_tray(app: &AppHandle, visible: bool) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Afficher Mistral Desktop", true, None::<&str>)?;
    let new = MenuItem::with_id(app, "new", "Nouvelle conversation", true, None::<&str>)?;
    let temp = MenuItem::with_id(app, "temporary", "Conversation temporaire", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &new, &temp, &sep, &quit])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Mistral Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "show" => show_main(app),
            "new" | "temporary" => open_with(app, ev.id().as_ref()),
            "quit" => app.exit(0),
            _ => {}
        })
        // Clic gauche (Windows, macOS) : affiche la fenêtre. Sous Linux, seul le menu est disponible.
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder.build(app)?;
    tray.set_visible(visible)?;
    Ok(())
}

pub fn set_tray_visible(app: &AppHandle, visible: bool) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_visible(visible);
    }
}

/// Fermer la fenêtre la masque dans la barre système au lieu de quitter ?
pub fn hide_on_close(app: &AppHandle) -> bool {
    crate::storage::load_settings(app).map(|s| s.tray_icon && s.close_to_tray).unwrap_or(false)
}

/// Valide un raccourci (« CommandOrControl+Shift+Space »…). Vide = aucun.
pub fn parse_shortcut(text: &str) -> Result<Option<Shortcut>, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(None);
    }
    text.parse::<Shortcut>().map(Some).map_err(|e| format!("Raccourci global invalide « {text} » : {e}"))
}

/// (Ré)enregistre le raccourci global. Une erreur (raccourci déjà pris par une autre application,
/// session Wayland…) est renvoyée pour être affichée, sans empêcher le reste de fonctionner.
pub fn apply_shortcut(app: &AppHandle, text: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    if let Some(sc) = parse_shortcut(text)? {
        gs.on_shortcut(sc, |app, _sc, ev| {
            if ev.state == ShortcutState::Pressed {
                open_with(app, "new");
            }
        })
        .map_err(|e| format!("Raccourci global « {} » indisponible : {e}", text.trim()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_shortcut;

    #[test]
    fn shortcut_parsing() {
        assert!(parse_shortcut("").unwrap().is_none());
        assert!(parse_shortcut("CommandOrControl+Shift+Space").unwrap().is_some());
        assert!(parse_shortcut("Alt+M").unwrap().is_some());
        assert!(parse_shortcut("Ctrl+Truc+").is_err());
    }
}
