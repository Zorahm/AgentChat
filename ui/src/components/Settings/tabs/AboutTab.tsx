import { useRef, useState } from "react";
import { Atom, Lightning, Desktop, Brain, Code, ArrowClockwise, CheckCircle, WarningCircle, X, CloudArrowDown } from "@phosphor-icons/react";
import { checkForUpdate, installUpdate, type UpdateStatus } from "../../../utils/updater";
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

  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const dl = useRef({ done: 0, total: 0 });

  const busy = status.state === "checking" || status.state === "downloading" || status.state === "installing";
  const cardOpen = status.state !== "idle";

  const handleCheck = async () => {
    if (busy) return;
    setStatus({ state: "checking" });
    setStatus(await checkForUpdate());
  };

  const handleInstall = async () => {
    dl.current = { done: 0, total: 0 };
    await installUpdate((s) => {
      if (s.state === "downloading") {
        if (s.total) dl.current.total = s.total;
        dl.current.done += s.progress;
        const pct = dl.current.total ? Math.round((dl.current.done / dl.current.total) * 100) : 0;
        setStatus({ state: "downloading", progress: pct });
      } else {
        setStatus(s);
      }
    });
  };

  const closeCard = () => setStatus({ state: "idle" });

  const renderUpdateCard = () => {
    switch (status.state) {
      case "checking":
        return (
          <div className="st2-update-card">
            <ArrowClockwise className="spin" />
            <span className="st2-update-card-msg">Проверяю обновления…</span>
          </div>
        );
      case "available":
        return (
          <div className="st2-update-card is-available">
            <button className="st2-update-card-x" onClick={closeCard} title="Закрыть"><X /></button>
            <div className="st2-update-card-head">
              <CloudArrowDown />
              <span>Доступно обновление</span>
            </div>
            <div className="st2-update-card-ver">v{pkg.version} → <b>v{status.version}</b></div>
            {status.body && <div className="st2-update-card-notes">{status.body}</div>}
            <button className="st2-btn st2-update-card-go" onClick={handleInstall}>
              Обновить и перезапустить
            </button>
          </div>
        );
      case "downloading":
        return (
          <div className="st2-update-card">
            <ArrowClockwise className="spin" />
            <span className="st2-update-card-msg">Загрузка… {status.progress}%</span>
          </div>
        );
      case "installing":
        return (
          <div className="st2-update-card">
            <ArrowClockwise className="spin" />
            <span className="st2-update-card-msg">Установка… приложение перезапустится.</span>
          </div>
        );
      case "latest":
        return (
          <div className="st2-update-card is-latest">
            <button className="st2-update-card-x" onClick={closeCard} title="Закрыть"><X /></button>
            <CheckCircle />
            <span className="st2-update-card-msg">У вас последняя версия</span>
          </div>
        );
      case "error":
        return (
          <div className="st2-update-card is-error">
            <button className="st2-update-card-x" onClick={closeCard} title="Закрыть"><X /></button>
            <WarningCircle />
            <span className="st2-update-card-msg">{status.message}</span>
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

    <div className="st2-section st2-version-section">
      <div className="st2-version-row">
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
          <button className="st2-update-btn" onClick={handleCheck} disabled={busy}>
            <ArrowClockwise className={busy ? "spin" : ""} />
            {status.state === "checking" ? "Проверяю…" : "Проверить обновления"}
          </button>
        )}
      </div>
      {isTauri() && cardOpen && renderUpdateCard()}
    </div>
  </>;
}
