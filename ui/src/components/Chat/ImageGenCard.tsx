/** Image card — the visible result of an `image_generate` call.
 *
 *  Rendered directly in the chat flow (lifted out of the collapsed process
 *  block, like ResearchCard): generating an image the user never sees would be
 *  pointless, so the tool draws its own card and `present_files` stays optional.
 *
 *  Tiles appear one by one as `image` progress events arrive; until then the
 *  grid holds placeholders sized to the requested count. */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, ImageBroken } from "@phosphor-icons/react";
import { IconButton } from "@astryxdesign/core/IconButton";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import type { GeneratedImageRef, ToolCall } from "../../types/tool-call";
import { API_BASE, withToken } from "../../utils/apiBase";
import { copyText } from "../../utils/copyText";
import {
  imageCopyText,
  imageNegativePrompt,
  imageParams,
  imagePrompt,
  normalizeImageGen,
} from "../../utils/imageGen";

interface ImageGenCardProps {
  call: ToolCall;
}

export function ImageGenCard({ call }: ImageGenCardProps) {
  const { t } = useTranslation();
  if (!call.image) return null;
  const image = normalizeImageGen(call.image);

  const running = image.status === "running";
  const failed = image.status === "failed";
  const prompt = imagePrompt(call);
  const negative = imageNegativePrompt(call);
  // Placeholders stand in for images still rendering; a cancelled or failed run
  // keeps only what actually landed.
  const placeholders = running ? Math.max(0, image.count - image.images.length) : 0;

  return (
    <div className="imggen-card">
      <div className="imggen-head">
        <div className="imggen-prompt-row">
          {/* Shown in full, never clamped: the model writes this prompt itself,
              so a truncated one hides what the user's GPU was actually told to
              draw. */}
          <p className="imggen-title">{prompt || t("chat.imageGen.untitled")}</p>
          {prompt && <CopyButton call={call} />}
        </div>
        {negative && (
          <p className="imggen-negative">
            <span className="imggen-negative-label">{t("chat.imageGen.negative")}</span> {negative}
          </p>
        )}
        <span className="imggen-meta">{metaLine(call, image, t)}</span>
      </div>

      {running && (
        <ProgressBar
          label={image.statusText || t("chat.imageGen.rendering")}
          value={image.percent}
          isIndeterminate={image.percent === undefined}
          hasValueLabel={image.percent !== undefined}
        />
      )}

      {failed ? (
        <div className="imggen-error">
          <ImageBroken weight="bold" />
          <span>{image.error || t("chat.imageGen.failed")}</span>
        </div>
      ) : (
        <div className="imggen-grid" data-count={Math.max(1, image.images.length + placeholders)}>
          {image.images.map((ref) => (
            <ImageTile key={ref.path} image={ref} alt={prompt} />
          ))}
          {Array.from({ length: placeholders }, (_, i) => (
            <div className="imggen-tile imggen-tile--pending" key={`pending-${i}`} />
          ))}
        </div>
      )}
    </div>
  );
}

interface ImageTileProps {
  image: GeneratedImageRef;
  alt: string;
}

function ImageTile({ image, alt }: ImageTileProps) {
  const open = (): void => {
    window.dispatchEvent(new CustomEvent("open-artifact", { detail: image.path }));
  };
  const src = withToken(`${API_BASE}/files/serve?path=${encodeURIComponent(image.path)}`);

  return (
    <button className="imggen-tile" onClick={open} type="button">
      <img src={src} alt={alt} loading="lazy" />
    </button>
  );
}

interface CopyButtonProps {
  call: ToolCall;
}

/** Copies the render in AUTOMATIC1111's paste format, so it can be reproduced. */
function CopyButton({ call }: CopyButtonProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async (): Promise<void> => {
    await copyText(imageCopyText(call));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <IconButton
      icon={copied ? <Check size={15} /> : <Copy size={15} />}
      label={copied ? t("chat.copied") : t("chat.imageGen.copyPrompt")}
      tooltip={copied ? t("chat.copied") : t("chat.imageGen.copyPrompt")}
      onClick={handleCopy}
      variant="ghost"
      size="sm"
    />
  );
}

/** "a1111 · 1024×1024 · Steps: 25 · seed 12345" — whichever parts are known. */
function metaLine(
  call: ToolCall,
  image: ReturnType<typeof normalizeImageGen>,
  t: (key: string) => string,
): string {
  const first = image.images[0];
  const seeds = image.images.map((i) => i.seed).filter((s): s is number => typeof s === "number");
  return [
    image.backend && image.backend !== "none" ? image.backend : "",
    first && first.width > 0 ? `${first.width}×${first.height}` : "",
    // Sampler settings the model picked — part of what the user is owed, and
    // what makes the seed below actually reproducible.
    ...imageParams(call),
    seeds.length > 0 ? `${t("chat.imageGen.seed")} ${seeds.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
