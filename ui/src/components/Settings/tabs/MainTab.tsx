import { useCallback, useEffect, useRef, useState } from "react";
import {
  Sun, Moon, Monitor, Camera, SignOut, Warning, Trash,
  X as XIcon, ArrowClockwise, CheckCircle, XCircle, Terminal,
} from "@phosphor-icons/react";
import { AvatarCircle } from "../../Sidebar";
import { API_BASE } from "../../../utils/apiBase";
import type { SettingsData } from "../SettingsPanel";

/* ── MainTab ──────────────────── */

export function MainTab({ settings, onUpdate, avatarUrl, setAvatarFromFile, clearAvatar, onSignOut }: {
  settings: SettingsData;
  onUpdate: (patch: Partial<SettingsData>) => void;
  avatarUrl: string | null;
  setAvatarFromFile: (file: File) => Promise<void>;
  clearAvatar: () => void;
  onSignOut: (deleteChats: boolean) => void;
}) {
  const [draft, setDraft] = useState(settings.user_name ?? "");
  const [showSignOut, setShowSignOut] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(settings.user_name ?? "");
  }, [settings.user_name]);

  const handleBlur = useCallback(() => {
    if (draft !== (settings.user_name ?? "")) {
      onUpdate({ user_name: draft });
    }
  }, [draft, settings.user_name, onUpdate]);

  const handleAvatarFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await setAvatarFromFile(file);
    e.target.value = "";
  }, [setAvatarFromFile]);

  const currentTheme = settings.theme || "system";
  const unrestricted = settings.unrestricted_mode ?? false;

  return (
    <div className="st2-main">
      <h3 className="st2-h">Главное</h3>
      <p className="st2-sub">
        Личные настройки и поведение приложения по умолчанию.
        Всё хранится локально — никаких облачных аккаунтов.
      </p>

      {/* 01 Профиль */}
      <section>
        <div className="st2-mh">
          <span className="st2-mn">01</span>
          <h2>Профиль</h2>
        </div>
        <p className="st2-md">
          Как модель к вам обращается. Не отправляется наружу.
        </p>
        <div className="st2-mrows">
          {/* Avatar row */}
          <div className="st2-mrow st2-mrow--avatar">
            <div className="st2-mlab">
              <p className="t">Аватарка</p>
              <p className="d">Отображается в сайдбаре. Хранится только локально.</p>
            </div>
            <div className="st2-mctl">
              <div className="st2-avatar-wrap">
                <div
                  className="st2-avatar-preview"
                  onClick={() => avatarInputRef.current?.click()}
                  title="Нажми чтобы загрузить фото"
                >
                  <AvatarCircle url={avatarUrl} name={draft || settings.user_name} size={64} />
                  <div className="st2-avatar-overlay">
                    <Camera size={18} weight="bold" />
                  </div>
                </div>
                <div className="st2-avatar-actions">
                  <button
                    className="st2-avatar-btn"
                    onClick={() => avatarInputRef.current?.click()}
                  >
                    {avatarUrl ? "Изменить фото" : "Загрузить фото"}
                  </button>
                  {avatarUrl && (
                    <button
                      className="st2-avatar-btn st2-avatar-btn--del"
                      onClick={clearAvatar}
                    >
                      <XIcon size={12} weight="bold" /> Удалить
                    </button>
                  )}
                  <p className="st2-avatar-hint">JPG, PNG, WEBP · обрезается до квадрата</p>
                </div>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={handleAvatarFile}
                />
              </div>
            </div>
          </div>

          {/* Name row */}
          <div className="st2-mrow">
            <div className="st2-mlab">
              <p className="t">Имя пользователя</p>
              <p className="d">
                Модель использует это имя в обращениях. Можно оставить пустым.
              </p>
            </div>
            <div className="st2-mctl">
              <input type="text" className="st2-input" value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={handleBlur}
                placeholder="Введите имя" />
            </div>
          </div>

          {/* Sign out row */}
          <div className="st2-mrow st2-mrow--signout">
            <div className="st2-mlab">
              <p className="t">Выход из профиля</p>
              <p className="d">Сбросить имя, аватарку и при желании удалить все чаты.</p>
            </div>
            <div className="st2-mctl">
              <button className="st2-signout-btn" onClick={() => setShowSignOut(true)}>
                <SignOut size={14} weight="bold" />
                Выйти из профиля
              </button>
            </div>
          </div>
        </div>
      </section>

      {showSignOut && (
        <SignOutDialog
          onClose={() => setShowSignOut(false)}
          onConfirm={(deleteChats) => { setShowSignOut(false); onSignOut(deleteChats); }}
        />
      )}

      {/* 02 Оформление */}
      <section>
        <div className="st2-mh">
          <span className="st2-mn">02</span>
          <h2>Оформление</h2>
        </div>
        <p className="st2-md">
          Светлая, тёмная или системная тема. Полная палитра настраивается в теме CSS.
        </p>
        <div className="st2-mrows">
          <div className="st2-mrow">
            <div className="st2-mlab">
              <p className="t">Тема оформления</p>
              <p className="d">Цветовая схема всего интерфейса.</p>
            </div>
            <div className="st2-mctl">
              <div className="st2-theme">
                <button className={currentTheme === "light" ? "active" : ""}
                  onClick={() => onUpdate({ theme: "light" })}>
                  <Sun /> Светлая
                </button>
                <button className={currentTheme === "dark" ? "active" : ""}
                  onClick={() => onUpdate({ theme: "dark" })}>
                  <Moon /> Тёмная
                </button>
                <button className={currentTheme === "system" ? "active" : ""}
                  onClick={() => onUpdate({ theme: "system" })}>
                  <Monitor /> Системная
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 03 Песочница */}
      <section>
        <div className="st2-mh">
          <span className="st2-mn">03</span>
          <h2>Песочница</h2>
        </div>
        <p className="st2-md">
          Граница доступа к файлам и оболочке. По умолчанию модель видит только папку текущего чата.
        </p>
        <div className="st2-mrows">
          <div className="st2-mrow stack">
            <div className="st2-mctl">
              <div className={`st2-danger-row${unrestricted ? " on" : ""}`}>
                <div className="lab">
                  <p className="t">Unrestricted mode</p>
                  <p className="d">
                    Полный доступ к ПК — модель сможет читать <code>~/.ssh</code>,
                    <code>AppData</code> и писать куда угодно. Включайте, только если
                    понимаете риск.
                  </p>
                </div>
                <div className="st2-danger-switch">
                  <div className={`st2-switch${unrestricted ? " on" : ""}`}
                    onClick={() => onUpdate({ unrestricted_mode: !unrestricted })} />
                </div>
              </div>
              {unrestricted && (
                <div className="st2-risk-note">
                  <b>Песочница снята.</b> Модель и агент имеют полный доступ к WSL и Windows.
                  <ul>
                    <li>Модель может читать любые файлы, включая <code>~/.ssh</code> и <code>AppData</code>.</li>
                    <li>bash и другие инструменты работают без изоляции.</li>
                    <li>Перезапустите агента, чтобы вернуть песочницу.</li>
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 04 Терминал */}
      <ShellSection
        preference={settings.shell_preference ?? "auto"}
        onChange={(v) => onUpdate({ shell_preference: v })}
      />
    </div>
  );
}

/* ── Shell (WSL ⇄ PowerShell) ───────────────────── */

interface ShellStatus {
  wsl_installed: boolean;
  default_distro: string | null;
  distro_running: boolean;
  node: string | null;
  python: string | null;
  npm: string | null;
  pandoc: string | null;
  libreoffice: string | null;
  poppler: boolean;
  docx: boolean;
  dns_ok: boolean;
  powershell_available: boolean;
  active_shell: "wsl" | "powershell";
  shell_preference: "auto" | "wsl" | "powershell";
}

function ShellSection({
  preference,
  onChange,
}: {
  preference: "auto" | "wsl" | "powershell";
  onChange: (v: "auto" | "wsl" | "powershell") => void;
}) {
  const [status, setStatus] = useState<ShellStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<null | "distro" | "deps" | "dns">(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/wsl/status`);
      if (r.ok) setStatus(await r.json());
    } catch { /* no-op */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const installDistro = async () => {
    setInstalling("distro");
    setMessage(null);
    try {
      const r = await fetch(`${API_BASE}/wsl/install-distro`, { method: "POST" });
      const data = await r.json();
      setMessage(data.output ?? (r.ok ? "Установка запущена" : "Ошибка"));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Сеть недоступна");
    } finally {
      setInstalling(null);
      reload();
    }
  };

  const installDeps = async () => {
    setInstalling("deps");
    setMessage("Запускаю установку…");
    try {
      const r = await fetch(`${API_BASE}/wsl/install-deps`, { method: "POST" });
      const data = await r.json();
      if (!r.ok) {
        setMessage(data.output ?? "Не удалось запустить установку");
        setInstalling(null);
        return;
      }
      setMessage(data.output ?? "Установка запущена…");

      // Poll the background task every 3s until it stops running.
      let lastLog = "";
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        try {
          const s = await fetch(`${API_BASE}/wsl/install-deps/status`);
          if (!s.ok) continue;
          const payload = await s.json() as { running: boolean; log: string; error: string | null };
          if (payload.log && payload.log !== lastLog) {
            lastLog = payload.log;
            setMessage(payload.log);
          }
          if (!payload.running) {
            if (payload.error) setMessage(`${payload.log}\n\nОшибка: ${payload.error}`);
            break;
          }
        } catch { /* keep polling */ }
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Сеть недоступна");
    } finally {
      setInstalling(null);
      reload();
    }
  };

  const fixDns = async () => {
    setInstalling("dns");
    setMessage(null);
    try {
      const r = await fetch(`${API_BASE}/wsl/fix-dns`, { method: "POST" });
      const data = await r.json();
      setMessage(data.output ?? (r.ok ? "DNS починен — WSL перезапущен" : "Ошибка"));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Сеть недоступна");
    } finally {
      setInstalling(null);
      reload();
    }
  };

  const wslOk = !!status?.wsl_installed && !!status?.distro_running;
  const psOk = !!status?.powershell_available;
  const activeShell = status?.active_shell ?? (preference === "powershell" ? "powershell" : "wsl");

  return (
    <section>
      <div className="st2-mh">
        <span className="st2-mn">04</span>
        <h2>Терминал</h2>
      </div>
      <p className="st2-md">
        Через какой шелл агент выполняет команды. По умолчанию — bash внутри WSL,
        с автоматическим откатом на Windows PowerShell, если WSL не установлен.
      </p>

      <div className="st2-mrows">
        {/* Status grid */}
        <div className="st2-mrow stack">
          <div className="st2-mctl">
            <div className="st2-shell-grid">
              <ShellStatusCard
                title="WSL · bash"
                ok={wslOk}
                lines={[
                  status
                    ? status.wsl_installed
                      ? `wsl.exe найден${status.default_distro ? ` · ${status.default_distro}` : ""}`
                      : "wsl.exe не установлен"
                    : "—",
                  status?.wsl_installed
                    ? status.distro_running
                      ? "Дистрибутив запускается"
                      : "Дистрибутив недоступен"
                    : "",
                  status?.distro_running
                    ? [
                        status.node ? "node ✓" : "node ✗",
                        status.python ? "python3 ✓" : "python3 ✗",
                        status.npm ? "npm ✓" : "npm ✗",
                        status.pandoc ? "pandoc ✓" : "pandoc ✗",
                        status.libreoffice ? "libreoffice ✓" : "libreoffice ✗",
                        status.poppler ? "poppler ✓" : "poppler ✗",
                        status.dns_ok ? "DNS ✓" : "DNS ✗",
                      ].join(" · ")
                    : "",
                ].filter(Boolean)}
                active={activeShell === "wsl"}
              />
              <ShellStatusCard
                title="Windows PowerShell"
                ok={psOk}
                lines={[
                  status
                    ? status.powershell_available
                      ? "powershell.exe найден"
                      : "powershell.exe не найден"
                    : "—",
                  "Без bwrap-cage — песочница «мягкая»",
                ]}
                active={activeShell === "powershell"}
              />
            </div>
          </div>
        </div>

        {/* Preference picker */}
        <div className="st2-mrow">
          <div className="st2-mlab">
            <p className="t">Какой шелл использовать</p>
            <p className="d">
              «Авто» — bash в WSL, при ошибке откат на PowerShell. «Только WSL» —
              падать с ошибкой, если WSL недоступен. «Только PowerShell» —
              никогда не звать WSL.
            </p>
          </div>
          <div className="st2-mctl">
            <div className="st2-theme">
              <button
                className={preference === "auto" ? "active" : ""}
                onClick={() => onChange("auto")}
              >
                <Terminal /> Авто
              </button>
              <button
                className={preference === "wsl" ? "active" : ""}
                onClick={() => onChange("wsl")}
              >
                <Terminal /> WSL
              </button>
              <button
                className={preference === "powershell" ? "active" : ""}
                onClick={() => onChange("powershell")}
              >
                <Terminal /> PowerShell
              </button>
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="st2-mrow stack">
          <div className="st2-mctl">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button
                className="st2-btn"
                onClick={installDistro}
                disabled={installing !== null}
                title="Запускает `wsl --install -d Ubuntu` с правами администратора"
              >
                {installing === "distro" ? "Установка…" : "Установить WSL + Ubuntu"}
              </button>
              <button
                className="st2-btn"
                onClick={installDeps}
                disabled={installing !== null || !status?.distro_running}
                title="Ставит Node, Python, pandoc, LibreOffice, poppler-utils и npm docx внутри WSL. Сам чинит DNS, если он сломан."
              >
                {installing === "deps" ? "Установка…" : "Установить необходимые библиотеки"}
              </button>
              {status?.distro_running && !status.dns_ok && (
                <button
                  className="st2-btn"
                  onClick={fixDns}
                  disabled={installing !== null}
                  title="Прописывает Cloudflare/Google DNS в /etc/resolv.conf и блокирует автогенерацию через /etc/wsl.conf, затем wsl --shutdown"
                >
                  {installing === "dns" ? "Чиню…" : "Починить DNS"}
                </button>
              )}
              <button
                className="st2-btn st2-btn--ghost"
                onClick={reload}
                disabled={loading}
              >
                <ArrowClockwise /> {loading ? "Проверяю…" : "Проверить снова"}
              </button>
              {!wslOk && psOk && preference !== "powershell" && (
                <button
                  className="st2-btn"
                  onClick={() => onChange("powershell")}
                  title="WSL недоступен — переключиться на Windows PowerShell"
                >
                  Перейти на PowerShell
                </button>
              )}
            </div>
            {message && (
              <pre className="st2-shell-msg">{message}</pre>
            )}
            {activeShell === "powershell" && (
              <div className="st2-risk-note" style={{ marginTop: 10 }}>
                <b>Режим PowerShell.</b> bwrap-песочница на Windows недоступна —
                модель ограничена только папкой чата через проверки путей,
                kernel-level изоляции нет.
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function ShellStatusCard({
  title,
  ok,
  lines,
  active,
}: {
  title: string;
  ok: boolean;
  lines: string[];
  active: boolean;
}) {
  return (
    <div className={`st2-shell-card${active ? " active" : ""}${ok ? " ok" : " bad"}`}>
      <div className="st2-shell-card-h">
        {ok ? <CheckCircle weight="fill" /> : <XCircle weight="fill" />}
        <span className="st2-shell-card-title">{title}</span>
        {active && <span className="st2-shell-card-active">активен</span>}
      </div>
      {lines.map((ln, i) => (
        <div key={i} className="st2-shell-card-ln">{ln}</div>
      ))}
    </div>
  );
}

/* ── Sign Out Dialog ────────────────────────────────────────────────────── */

function SignOutDialog({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (deleteChats: boolean) => void;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);

  return (
    <div className="confirm-overlay" onClick={onClose}>
      <div className="confirm-dialog signout-dialog" onClick={(e) => e.stopPropagation()}>
        <button className="confirm-close" onClick={onClose}><XIcon weight="bold" /></button>

        <div className="signout-header">
          <div className="signout-icon"><Warning size={22} weight="fill" /></div>
          <div>
            <h3 className="confirm-title">Выход из профиля</h3>
            <p className="signout-sub">Выберите что сделать с данными</p>
          </div>
        </div>

        <div className="signout-options">
          <button
            className="signout-opt signout-opt--danger"
            onClick={() => onConfirm(true)}
          >
            <div className="signout-opt-icon"><Trash size={16} weight="bold" /></div>
            <div className="signout-opt-text">
              <span className="signout-opt-title">Удалить всё</span>
              <span className="signout-opt-desc">Чаты, история и личные данные будут стёрты</span>
            </div>
          </button>

          <button
            className="signout-opt"
            onClick={() => onConfirm(false)}
          >
            <div className="signout-opt-icon"><SignOut size={16} weight="bold" /></div>
            <div className="signout-opt-text">
              <span className="signout-opt-title">Сохранить чаты</span>
              <span className="signout-opt-desc">Только имя и аватарка будут сброшены</span>
            </div>
          </button>
        </div>

        <button className="confirm-btn confirm-btn--cancel" style={{ width: "100%", textAlign: "center", marginTop: 4 }} onClick={onClose}>
          Отмена
        </button>
      </div>
    </div>
  );
}
