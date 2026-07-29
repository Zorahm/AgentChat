/** Domain-aggregated sources, as Astryx Citation chips with favicons.
 *  Shared by the research panel and the web_search tool block.
 *
 *  Aggregated by domain rather than per-URL because that is all the data we
 *  have — search results give us links, not source titles — and "mostly arxiv"
 *  is the useful glance while a run is in flight. The per-domain count rides in
 *  the chip label; Citation has no slot of its own for it.
 *
 *  Citation renders a real <a target="_blank">, which the app-wide link
 *  interceptor (utils/openExternal) routes to the OS browser. */

import { Citation } from "@astryxdesign/core/Citation";
import { useTranslation } from "react-i18next";
import { type SourceAgg, faviconUrl } from "../../utils/research";

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
      {top.map((d, i) => (
        <Citation
          key={d.domain}
          number={i + 1}
          variant="label"
          source={{
            title: d.count > 1 ? `${d.domain} · ${d.count}` : d.domain,
            url: `https://${d.domain}`,
            icon: faviconUrl(d.domain),
          }}
        />
      ))}
      {otherCount > 0 && (
        <span className="rp-source-more">
          {t("chat.research.panel.otherSources", { count: otherCount })}
        </span>
      )}
    </div>
  );
}
