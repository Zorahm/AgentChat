// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Desktop entry point. The real app logic lives in lib.rs `run()` so the same
// code can be driven by the mobile (Android/iOS) native entry point too.
fn main() {
    agentchat_lib::run()
}
