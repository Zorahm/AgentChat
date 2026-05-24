import { useState } from "react";
import { Atom, Lightning, Desktop, Brain, Code, GithubLogo, Globe, ArrowClockwise, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { checkForUpdates, type UpdateStatus } from "../../../utils/updater";
import { isTauri } from "../../../utils/tauri";
import pkg from "../../../../package.json";
import avatarZorahm from "../../../assets/avatar-zorahm.png";
import avatarHerman from "../../../assets/avatar-hermandebush.png";

export function AboutTab({ onStartGhostChat }: { onStartGhostChat?: () => void }) {
  const [ghostClicks, setGhostClicks] = useState(0);
  const stack = [
    { name: "React", icon: <Atom />, desc: "UI-фреймворк" },
    { name: "TypeScript", icon: <Code />, desc: "Типизированный фронтенд" },
    { name: "FastAPI", icon: <Lightning />, desc: "Асинхронный бэкенд" },
    { name: "LiteLLM", icon: <Brain />, desc: "Прокси для LLM-провайдеров" },
    { name: "Tauri", icon: <Desktop />, desc: "Десктопная оболочка" },
    { name: "Python", icon: <Code />, desc: "Агентный цикл, инструменты" },
  ];

  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: "idle" });
  const [checking, setChecking] = useState(false);

  const handleCheckUpdate = async () => {
    if (checking) return;
    setChecking(true);
    await checkForUpdates((status) => {
      setUpdateStatus(status);
      if (status.state === "latest" || status.state === "error" || status.state === "installing") {
        setChecking(false);
      }
    });
  };

  const renderUpdateStatus = () => {
    switch (updateStatus.state) {
      case "checking":
        return (
          <div className="st2-update-status">
            <ArrowClockwise className="spin" /> Проверяю обновления...
          </div>
        );
      case "available":
        return (
          <div className="st2-update-status st2-update-available">
            <WarningCircle /> Доступна версия <b>v{updateStatus.version}</b>
          </div>
        );
      case "downloading":
        return (
          <div className="st2-update-status">
            <ArrowClockwise className="spin" /> Загрузка обновления...
          </div>
        );
      case "installing":
        return (
          <div className="st2-update-status">
            <ArrowClockwise className="spin" /> Установка... Перезапустите приложение.
          </div>
        );
      case "latest":
        return (
          <div className="st2-update-status st2-update-latest">
            <CheckCircle /> Установлена последняя версия
          </div>
        );
      case "error":
        return (
          <div className="st2-update-status st2-update-error">
            <WarningCircle /> {updateStatus.message}
          </div>
        );
      default:
        return null;
    }
  };

  return <>
    <h3 className="st2-h">О приложении</h3>
    <p className="st2-sub">
      AgentChat — десктопный чат для рабочих задач и брейншторминга.<br />
      Локальный, конфиденциальный, без привязки к редактированию кода.
    </p>

    <div className="st2-section">
      <h4 style={{ marginBottom: 10 }}>Стек</h4>
      <div className="st2-about-stack">
        {stack.map((s) => (
          <div key={s.name} className="st2-about-stack-item">
            <span className="st2-about-stack-ic">{s.icon}</span>
            <span className="st2-about-stack-name">{s.name}</span>
            <span className="st2-about-stack-desc">{s.desc}</span>
          </div>
        ))}
      </div>
    </div>

    <div className="st2-section">
      <h4 style={{ marginBottom: 10 }}>Версия приложения</h4>
      <div className="st2-about-version">
        <div className="st2-about-author" style={{ gap: 12 }}>
          <div style={{ position: "relative", width: 36, height: 36 }}>
            {ghostClicks >= 5 && (
              <button 
                className="st2-ghost-btn revealed"
                onClick={onStartGhostChat}
                title="????"
              >
                +
              </button>
            )}
            <img 
              src="/dots.svg" 
              alt="" 
              onClick={() => setGhostClicks(c => c + 1)}
              className={ghostClicks >= 5 ? "st2-ghost-fall" : ""}
              style={{ position: "absolute", inset: 0, width: 36, height: 36, borderRadius: 7, zIndex: 2 }} 
            />
          </div>
          <div>
            <span className="st2-about-author-name">AgentChat</span>
            <span className="st2-about-author-meta">v{pkg.version}</span>
          </div>
        </div>
        {isTauri() && (
          <div className="st2-update-row">
            <button
              className="st2-btn st2-btn--ghost"
              onClick={handleCheckUpdate}
              disabled={checking}
            >
              <ArrowClockwise /> {checking ? "Проверяю..." : "Проверить обновления"}
            </button>
            {renderUpdateStatus()}
          </div>
        )}
      </div>
    </div>

    <div className="st2-section">
      <h4 style={{ marginBottom: 6 }}>Над проектом работали</h4>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="st2-about-author">
          <span className="st2-about-author-ic"><img src={avatarZorahm} alt="" /></span>
          <div className="st2-about-author-info">
            <a className="st2-about-author-name" href="https://github.com/zorahm" target="_blank" rel="noopener noreferrer">ZorahM</a>
            <span className="st2-about-author-meta">Backend &amp; UI</span>
          </div>
        </div>
        <div className="st2-about-author">
          <span className="st2-about-author-ic"><img src={avatarHerman} alt="" /></span>
          <div className="st2-about-author-info">
            <a className="st2-about-author-name" href="https://github.com/hermandebush" target="_blank" rel="noopener noreferrer">Herman</a>
            <span className="st2-about-author-meta">UX</span>
          </div>
        </div>
      </div>
    </div>

    <div className="st2-section">
      <h4 style={{ marginBottom: 6 }}>Цель</h4>
      <p className="st2-sub2">
        Чат, в котором можно обсудить рабочий вопрос, набросать идею,
        разобрать проблему — и не улетать в среду разработки. Никакого
        скрытого запуска скриптов, никакой магии терминала. Просто диалог.
      </p>
    </div>
  </>;
}
