/** Settings → Profile: avatar, display name, sign out. */

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, SignOut, Warning, Trash, X as XIcon, UserCircle, MagicWand } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { AvatarCircle } from "../../Sidebar";
import type { SettingsData } from "../SettingsPanel";

export function ProfileTab({ settings, onUpdate, avatarUrl, setAvatarFromFile, clearAvatar, onSignOut, onOpenOnboarding }: {
  settings: SettingsData;
  onUpdate: (patch: Partial<SettingsData>) => void;
  avatarUrl: string | null;
  setAvatarFromFile: (file: File) => Promise<void>;
  clearAvatar: () => void;
  onSignOut: (deleteChats: boolean) => void;
  onOpenOnboarding: () => void;
}) {
  const { t } = useTranslation();
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

  return (
    <div className="st2-main">
      <h3 className="st2-h">{t("settings.general.profile")}</h3>
      <p className="st2-sub">{t("settings.general.profileDescription")}</p>

      <div className="st2-mrows">
        {/* Avatar + Name combined */}
        <div className="st2-mrow">
          <div className="st2-mlab">
            <p className="t"><UserCircle size={16} /> {t("settings.general.avatar")}</p>
            <p className="d">{t("settings.general.avatarHint")}</p>
          </div>
          <div className="st2-mctl">
            <div className="id-combo">
              <div className="avatar-circle" onClick={() => avatarInputRef.current?.click()} title={t("settings.general.clickToUpload")}>
                <AvatarCircle url={avatarUrl} name={draft || settings.user_name} size={48} />
                <span className="edit-badge">✎</span>
              </div>
              <div className="input-wrap">
                <input type="text" value={draft} maxLength={32}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={handleBlur}
                  placeholder={t("settings.general.userNamePlaceholder")} />
                <span className="char-hint">{draft.length} / 32</span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button className="st2-avatar-btn" onClick={() => avatarInputRef.current?.click()}>
                <Camera size={14} /> {avatarUrl ? t("settings.general.changePhoto") : t("settings.general.uploadPhoto")}
              </button>
              {avatarUrl && (
                <button className="st2-avatar-btn st2-avatar-btn--del" onClick={clearAvatar}>
                  <XIcon size={12} weight="bold" /> {t("settings.general.deletePhoto")}
                </button>
              )}
            </div>
            <input ref={avatarInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleAvatarFile} />
          </div>
        </div>

        {/* Setup wizard row — re-open onboarding (non-destructive) */}
        <div className="st2-mrow">
          <div className="st2-mlab">
            <p className="t"><MagicWand size={16} /> {t("settings.general.setupWizard")}</p>
            <p className="d">{t("settings.general.setupWizardDescription")}</p>
          </div>
          <div className="st2-mctl">
            <button className="st2-avatar-btn" onClick={onOpenOnboarding}>
              <MagicWand size={14} /> {t("settings.general.setupWizardButton")}
            </button>
          </div>
        </div>

        {/* Sign out row */}
        <div className="st2-mrow">
          <div className="st2-mlab">
            <p className="t"><SignOut size={16} /> {t("settings.general.signOut")}</p>
            <p className="d">{t("settings.general.signOutDescription")}</p>
          </div>
          <div className="st2-mctl">
            <button className="st2-signout-btn" onClick={() => setShowSignOut(true)}>
              <SignOut size={14} weight="bold" />
              {t("settings.general.signOutButton")}
            </button>
          </div>
        </div>
      </div>

      {showSignOut && (
        <SignOutDialog
          onClose={() => setShowSignOut(false)}
          onConfirm={(deleteChats) => { setShowSignOut(false); onSignOut(deleteChats); }}
        />
      )}
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
  const { t } = useTranslation();
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
            <h3 className="confirm-title">{t("settings.signOut.title")}</h3>
            <p className="signout-sub">{t("settings.signOut.subtitle")}</p>
          </div>
        </div>

        <div className="signout-options">
          <button
            className="signout-opt signout-opt--danger"
            onClick={() => onConfirm(true)}
          >
            <div className="signout-opt-icon"><Trash size={16} weight="bold" /></div>
            <div className="signout-opt-text">
              <span className="signout-opt-title">{t("settings.signOut.deleteAll")}</span>
              <span className="signout-opt-desc">{t("settings.signOut.deleteAllHint")}</span>
            </div>
          </button>

          <button
            className="signout-opt"
            onClick={() => onConfirm(false)}
          >
            <div className="signout-opt-icon"><SignOut size={16} weight="bold" /></div>
            <div className="signout-opt-text">
              <span className="signout-opt-title">{t("settings.signOut.keepChats")}</span>
              <span className="signout-opt-desc">{t("settings.signOut.keepChatsHint")}</span>
            </div>
          </button>
        </div>

        <button className="confirm-btn confirm-btn--cancel" style={{ width: "100%", textAlign: "center", marginTop: 4 }} onClick={onClose}>
          {t("settings.signOut.cancel")}
        </button>
      </div>
    </div>
  );
}
