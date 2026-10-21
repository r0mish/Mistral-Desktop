// Pas de console supplémentaire sous Windows en release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Lancé par ssh comme SSH_ASKPASS : on relaie l'invite, sans interface.
    if let Some(code) = mistral_desktop_lib::askpass_main() {
        std::process::exit(code);
    }
    mistral_desktop_lib::run()
}
