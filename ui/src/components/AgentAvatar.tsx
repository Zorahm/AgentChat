import type { CSSProperties } from "react";
import { Avatar, type AvatarSize } from "@astryxdesign/core/Avatar";

/** Astryx's Avatar only accepts these discrete pixel sizes (its token scale) —
 *  callers here pass arbitrary design pixel values, so snap to the closest one. */
const AVATAR_SIZES = [16, 20, 24, 32, 36, 40, 48, 60, 64, 72, 96, 128, 144, 180] as const;
function nearestAvatarSize(px: number): AvatarSize {
  return AVATAR_SIZES.reduce((best, s) => (Math.abs(s - px) < Math.abs(best - px) ? s : best));
}

/** Gradient-circle avatar for an agent profile — the agent's visual identity.
 *  Wraps Astryx's Avatar (initials-from-name + a11y for free) and paints the
 *  two-color gradient over its fallback circle via `.agent-avatar` in
 *  components-agent-avatar.css — unlayered app CSS beats Astryx's
 *  `@layer astryx-base`, so no `!important` is needed (same technique used
 *  for CodeBlock/.astryx-markdown elsewhere in this migration). */
export interface AgentAvatarProps {
  name?: string;
  colorFrom: string;
  colorTo: string;
  size?: number;
  className?: string;
}

export function AgentAvatar({ name, colorFrom, colorTo, size = 20, className }: AgentAvatarProps) {
  return (
    <Avatar
      name={name}
      size={nearestAvatarSize(size)}
      className={`agent-avatar${className ? ` ${className}` : ""}`}
      style={{ "--agent-avatar-from": colorFrom, "--agent-avatar-to": colorTo } as CSSProperties}
    />
  );
}
