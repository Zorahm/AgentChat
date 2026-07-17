/** Gradient-circle avatar for an agent profile — the agent's visual identity. */

export interface AgentAvatarProps {
  colorFrom: string;
  colorTo: string;
  size?: number;
  className?: string;
}

export function AgentAvatar({ colorFrom, colorTo, size = 20, className }: AgentAvatarProps) {
  return (
    <span
      className={`agent-avatar${className ? ` ${className}` : ""}`}
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, ${colorFrom}, ${colorTo})`,
      }}
    />
  );
}
