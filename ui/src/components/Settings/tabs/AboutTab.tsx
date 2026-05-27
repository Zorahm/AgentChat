import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Atom, Lightning, Desktop, Brain, Code, ArrowClockwise, CheckCircle, WarningCircle, X, CloudArrowDown } from "@phosphor-icons/react";
import { checkForUpdate, installUpdate, type UpdateStatus } from "../../../utils/updater";
import { isTauri } from "../../../utils/tauri";
import pkg from "../../../../package.json";
import avatarZorahm from "../../../assets/avatar-zorahm.png";
import avatarHerman from "../../../assets/avatar-hermandebush.png";

export function AboutTab({ onStartGhostChat }: { onStartGhostChat?: () => void }) {
  const { t } = useTranslation();
  const [ghostClicks, setGhostClicks] = useState(0);
  const stack = [
    { name: "React", icon: <Atom />, desc: t("settings.about.stackReact") },
    { name: "TypeScript", icon: <Code />, desc: t("settings.about.stackTypescript") },
    { name: "FastAPI", icon: <Lightning />, desc: t("settings.about.stackFastapi") },
    { name: "LiteLLM", icon: <Brain />, desc: t("settings.about.stackLiteLLM") },
    { name: "Tauri", icon: <Desktop />, desc: t("settings.about.stackTauri") },
    { name: "Python", icon: <Code />, desc: t("settings.about.stackPython") },
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
            <span className="st2-update-card-msg">{t("settings.about.checking")}</span>
          </div>
        );
      case "available":
        return (
          <div className="st2-update-card is-available">
            <button className="st2-update-card-x" onClick={closeCard} title={t("settings.about.close")}><X /></button>
            <div className="st2-update-card-head">
              <CloudArrowDown />
              <span>{t("settings.about.updateAvailable")}</span>
            </div>
            <div className="st2-update-card-ver">{t("settings.about.updateTo", { from: pkg.version, to: status.version })}</div>
            {status.body && <div className="st2-update-card-notes">{status.body}</div>}
            <button className="st2-btn st2-update-card-go" onClick={handleInstall}>
              {t("settings.about.updateAndRestart")}
            </button>
          </div>
        );
      case "downloading":
        return (
          <div className="st2-update-card">
            <ArrowClockwise className="spin" />
            <span className="st2-update-card-msg">{t("settings.about.downloading")} {status.progress}%</span>
          </div>
        );
      case "installing":
        return (
          <div className="st2-update-card">
            <ArrowClockwise className="spin" />
            <span className="st2-update-card-msg">{t("settings.about.installing")}</span>
          </div>
        );
      case "latest":
        return (
          <div className="st2-update-card is-latest">
            <button className="st2-update-card-x" onClick={closeCard} title={t("settings.about.close")}><X /></button>
            <CheckCircle />
            <span className="st2-update-card-msg">{t("settings.about.latestVersion")}</span>
          </div>
        );
      case "error":
        return (
          <div className="st2-update-card is-error">
            <button className="st2-update-card-x" onClick={closeCard} title={t("settings.about.close")}><X /></button>
            <WarningCircle />
            <span className="st2-update-card-msg">{status.message}</span>
          </div>
        );
      default:
        return null;
    }
  };

  return <>
    <h3 className="st2-h">{t("settings.about.title")}</h3>
    <p className="st2-sub">
      {t("settings.about.description")}
    </p>

    <div className="st2-section">
      <h4 style={{ marginBottom: 10 }}>{t("settings.about.stack")}</h4>
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
      <h4 style={{ marginBottom: 6 }}>{t("settings.about.authors")}</h4>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="st2-about-author">
          <span className="st2-about-author-ic"><img src={avatarZorahm} alt="" /></span>
          <div className="st2-about-author-info">
            <a className="st2-about-author-name" href="https://github.com/zorahm" target="_blank" rel="noopener noreferrer">ZorahM</a>
            <span className="st2-about-author-meta">{t("settings.about.authorBackend")}</span>
          </div>
        </div>
        <div className="st2-about-author">
          <span className="st2-about-author-ic"><img src={avatarHerman} alt="" /></span>
          <div className="st2-about-author-info">
            <a className="st2-about-author-name" href="https://github.com/hermandebush" target="_blank" rel="noopener noreferrer">Herman</a>
            <span className="st2-about-author-meta">{t("settings.about.authorUx")}</span>
          </div>
        </div>
      </div>
    </div>

    <div className="st2-section">
      <h4 style={{ marginBottom: 6 }}>{t("settings.about.goal")}</h4>
      <p className="st2-sub2">
        {t("settings.about.goalText")}
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
            <span className="st2-about-author-name">{t("settings.about.appName")}</span>
            <span className="st2-about-author-meta">{t("settings.about.version")} {pkg.version}</span>
          </div>
        </div>
        {isTauri() && (
          <button className="st2-update-btn" onClick={handleCheck} disabled={busy}>
            <ArrowClockwise className={busy ? "spin" : ""} />
            {status.state === "checking" ? t("settings.about.checking") : t("settings.about.checkUpdates")}
          </button>
        )}
      </div>
      {isTauri() && cardOpen && renderUpdateCard()}
    </div>
  </>;
}
