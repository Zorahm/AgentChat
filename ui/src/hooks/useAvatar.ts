/** Avatar — reads/clears the base64 image previously stored in localStorage.
 *  Settings no longer offers a way to set a custom photo (base avatar only),
 *  so this only reads the legacy value and clears it on sign-out. */

import { useState, useCallback } from "react";

const AVATAR_KEY = "aic-avatar-v1";

function loadAvatar(): string | null {
  try { return localStorage.getItem(AVATAR_KEY); } catch { return null; }
}

export interface UseAvatarResult {
  avatarUrl: string | null;
  clearAvatar: () => void;
}

export function useAvatar(): UseAvatarResult {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(loadAvatar);

  const clearAvatar = useCallback(() => {
    localStorage.removeItem(AVATAR_KEY);
    setAvatarUrl(null);
  }, []);

  return { avatarUrl, clearAvatar };
}
