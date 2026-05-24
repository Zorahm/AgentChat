import { useState } from "react";
import { Folder } from "@phosphor-icons/react";
import { setBackendUrl } from "../../../utils/apiBase";

export function PathsTab() {
  const [backendUrl, setBackendUrlState] = useState(
    localStorage.getItem("agentchat.backendUrl") ?? ""
  );

  return <>
    <h3 className="st2-h">Пути</h3>
    <div className="st2-section">
      <h4>Папка скиллов</h4>
      <p className="st2-sub2">Распакованные .skill-пакеты. Watchdog следит за изменениями.</p>
      <div className="st2-path"><Folder /> skills/</div>
    </div>
    <div className="st2-section">
      <h4>Рабочая директория</h4>
      <p className="st2-sub2">Корень для bash_tool, относительные пути.</p>
      <div className="st2-path"><Folder /> ~/work</div>
    </div>
    <div className="st2-section">
      <h4>URL бэкенда</h4>
      <p className="st2-sub2">Оставьте пустым для локального (по умолчанию). Укажите адрес сервера для удалённого доступа с телефона.</p>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input
          type="text"
          value={backendUrl}
          onChange={(e) => setBackendUrlState(e.target.value)}
          placeholder="http://192.168.1.x:8787"
          style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-surface-2)", color: "var(--color-text)", fontSize: 13 }}
        />
        <button
          onClick={() => setBackendUrl(backendUrl)}
          style={{ padding: "6px 14px", borderRadius: 6, background: "var(--color-accent, #5865f2)", color: "#fff", border: "none", cursor: "pointer", fontSize: 13 }}
        >
          Применить
        </button>
      </div>
    </div>
  </>;
}
