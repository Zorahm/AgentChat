/** Avatar — stores a cropped base64 image in localStorage. */

import { useState, useCallback } from "react";

const AVATAR_KEY = "aic-avatar-v1";
const MAX_PX = 128; // output size

function loadAvatar(): string | null {
  try { return localStorage.getItem(AVATAR_KEY); } catch { return null; }
}

/** Resize + centre-crop an image file to MAX_PX×MAX_PX, return data-URL. */
function cropToSquare(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const size = Math.min(img.width, img.height);
      const sx = (img.width  - size) / 2;
      const sy = (img.height - size) / 2;
      const canvas = document.createElement("canvas");
      canvas.width  = MAX_PX;
      canvas.height = MAX_PX;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, sx, sy, size, size, 0, 0, MAX_PX, MAX_PX);
      resolve(canvas.toDataURL("image/jpeg", 0.88));
    };
    img.onerror = reject;
    img.src = url;
  });
}

export interface UseAvatarResult {
  avatarUrl: string | null;
  setAvatarFromFile: (file: File) => Promise<void>;
  clearAvatar: () => void;
}

export function useAvatar(): UseAvatarResult {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(loadAvatar);

  const setAvatarFromFile = useCallback(async (file: File) => {
    const dataUrl = await cropToSquare(file);
    localStorage.setItem(AVATAR_KEY, dataUrl);
    setAvatarUrl(dataUrl);
  }, []);

  const clearAvatar = useCallback(() => {
    localStorage.removeItem(AVATAR_KEY);
    setAvatarUrl(null);
  }, []);

  return { avatarUrl, setAvatarFromFile, clearAvatar };
}
