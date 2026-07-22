/** Domain-aggregated sources box — favicon · domain · count, with an "+N other"
 *  footer. Shared by the research panel and the web_search tool block. */

import { useState } from "react";
import { Globe } from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import { useTranslation } from "react-i18next";
import type { SourceAgg } from "../../utils/research";
import { openExternal } from "../../utils/openExternal";

interface SourcesBoxProps {
  agg: SourceAgg;
  topN?: number;
}

export function SourcesBox({ agg, topN = 5 }: SourcesBoxProps) {
  const { t } = useTranslation();
  const top = agg.domains.slice(0, topN);
  const otherCount = agg.domains.slice(topN).reduce((sum, d) => sum + d.count, 0);
  if (top.length === 0) return null;

  return (
    <div className="rp-sources">
      {top.map((d) => (
        <Button
          key={d.domain}
          label={d.domain}
          onClick={() => openExternal(`https://${d.domain}`)}
          tooltip={d.domain}
          variant="ghost"
          size="sm"
          className="rp-source-row"
        >
          <SourceFavicon domain={d.domain} />
          <span className="rp-source-domain">{d.domain}</span>
          <span className="rp-source-count">
            {t("chat.research.card.sources", { count: d.count })}
          </span>
        </Button>
      ))}
      {otherCount > 0 && (
        <div className="rp-source-more">
          {t("chat.research.panel.otherSources", { count: otherCount })}
        </div>
      )}
    </div>
  );
}

function SourceFavicon({ domain }: { domain: string }) {
  const [err, setErr] = useState(false);
  if (err) return <Globe size={14} className="rp-source-ic" />;
  return (
    <img
      className="rp-source-ic"
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`}
      alt=""
      loading="lazy"
      onError={() => setErr(true)}
    />
  );
}
