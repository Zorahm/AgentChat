; AgentChat NSIS installer hooks.
;
; The app runs its Python backend as a sidecar process: agentchat-backend.exe.
; Tauri's default NSIS template closes the main app (AgentChat.exe) on
; install/uninstall but NOT the sidecar, so the sidecar keeps its .exe locked
; and the file copy fails with the user having no idea what to close.
;
; Kill the sidecar before any files are touched. /T also tears down the
; PyInstaller bootloader's child interpreter; nsExec::Exec runs hidden (no
; console flash). The process name is unique to AgentChat, so this never
; touches an unrelated process.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping AgentChat backend..."
  nsExec::Exec 'taskkill /F /T /IM agentchat-backend.exe'
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping AgentChat backend..."
  nsExec::Exec 'taskkill /F /T /IM agentchat-backend.exe'
  Pop $0
!macroend
