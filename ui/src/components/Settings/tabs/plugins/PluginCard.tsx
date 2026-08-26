/** One installed Agent Plugin — the whole package on a single card.
 *
 * Skills and MCP servers are shown together deliberately: the standard's unit
 * is the plugin, so seeing what one brings (and what it failed to bring) in
 * two different tabs would hide exactly the thing the user is deciding about.
 */

import { useTranslation } from "react-i18next";
import {
  CaretDown,
  CaretRight,
  Trash,
  WarningCircle,
  Warning,
  Books,
  Plugs,
} from "@phosphor-icons/react";
import { Button } from "@astryxdesign/core/Button";
import { Switch } from "@astryxdesign/core/Switch";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { mcpDot } from "../../../../utils/mcpStatus";
import type { Plugin, PluginIssue } from "../../../../types/plugin";

export interface PluginCardProps {
  plugin: Plugin;
  open: boolean;
  onToggleOpen: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onDelete: () => void;
}

export function PluginCard({
  plugin,
  open,
  onToggleOpen,
  onSetEnabled,
  onDelete,
}: PluginCardProps) {
  const { t } = useTranslation();
  const errors = plugin.issues.filter((i) => i.level === "error");
  const warnings = plugin.issues.filter((i) => i.level === "warning");

  return (
    <div className={`plg-card${open ? " plg-card--open" : ""}`}>
      <div className="plg-head" onClick={onToggleOpen}>
        <span className="plg-dot">
          <StatusDot
            variant={plugin.valid ? (plugin.enabled ? "success" : "neutral") : "error"}
            label={t(
              plugin.valid
                ? plugin.enabled
                  ? "settings.plugins.state.enabled"
                  : "settings.plugins.state.disabled"
                : "settings.plugins.state.invalid",
            )}
          />
        </span>
        <span className="plg-name">{plugin.name}</span>
        {plugin.version && <span className="plg-version">{plugin.version}</span>}
        <span className="plg-summary">
          {plugin.description ?? t("settings.plugins.noDescription")}
        </span>
        {plugin.skills.length > 0 && (
          <span className="plg-tag" title={t("settings.plugins.skillsLabel")}>
            <Books size={11} weight="bold" /> {plugin.skills.length}
          </span>
        )}
        {plugin.mcp_servers.length > 0 && (
          <span className="plg-tag" title={t("settings.plugins.serversLabel")}>
            <Plugs size={11} weight="bold" /> {plugin.mcp_servers.length}
          </span>
        )}
        {errors.length > 0 && (
          <span className="plg-tag plg-tag--err">
            <WarningCircle size={11} weight="bold" /> {errors.length}
          </span>
        )}
        <span className="plg-spacer" />
        <span onClick={(e) => e.stopPropagation()}>
          <Switch
            label={t("settings.plugins.toggleLabel", { name: plugin.name })}
            isLabelHidden
            value={plugin.enabled}
            onChange={onSetEnabled}
            isDisabled={!plugin.valid}
            disabledMessage={t("settings.plugins.state.invalid")}
          />
        </span>
        <span className="plg-chevron">
          {open ? <CaretDown size={14} /> : <CaretRight size={14} />}
        </span>
      </div>

      {open && (
        <div className="plg-body">
          {plugin.author && (
            <p className="plg-meta">
              {t("settings.plugins.byAuthor", { author: plugin.author })}
              {plugin.license ? ` · ${plugin.license}` : ""}
            </p>
          )}
          {plugin.source && (
            <p className="plg-meta">
              {t("settings.plugins.source", { source: plugin.source })}
            </p>
          )}
          <p className="plg-path">{plugin.path}</p>

          {plugin.skills.length > 0 && (
            <section className="plg-section">
              <h4 className="plg-section-h">{t("settings.plugins.skillsLabel")}</h4>
              <ul className="plg-list">
                {plugin.skills.map((skill) => (
                  <li key={skill.path}>
                    <code>{skill.name}</code>
                    {skill.description && (
                      <span className="plg-list-desc"> — {skill.description}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {plugin.mcp_servers.length > 0 && (
            <section className="plg-section">
              <h4 className="plg-section-h">{t("settings.plugins.serversLabel")}</h4>
              <ul className="plg-list">
                {plugin.mcp_servers.map((server) => {
                  const dot = mcpDot(server.state);
                  return (
                    <li key={server.id}>
                      <span className="plg-dot">
                        <StatusDot
                          variant={dot.variant}
                          label={t(dot.labelKey)}
                          isPulsing={dot.isPulsing}
                        />
                      </span>
                      <code>{server.key}</code>
                      <span className="plg-list-desc">
                        {" "}
                        · {server.transport}
                        {server.tool_count > 0
                          ? ` · ${t("settings.plugins.toolCount", { count: server.tool_count })}`
                          : ""}
                      </span>
                      {server.last_error && (
                        <span className="plg-list-err"> — {server.last_error}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {plugin.issues.length > 0 && (
            <section className="plg-section">
              <h4 className="plg-section-h">{t("settings.plugins.issuesLabel")}</h4>
              <ul className="plg-issues">
                {errors.concat(warnings).map((issue, index) => (
                  <IssueRow key={`${issue.scope}-${issue.target}-${index}`} issue={issue} />
                ))}
              </ul>
            </section>
          )}

          <div className="plg-actions">
            {plugin.homepage && (
              <Button
                label={t("settings.plugins.homepage")}
                onClick={() => window.open(plugin.homepage ?? "", "_blank", "noopener")}
                variant="secondary"
                size="sm"
              />
            )}
            <Button
              label={t("settings.plugins.remove")}
              icon={<Trash size={14} />}
              onClick={onDelete}
              variant="secondary"
              size="sm"
              isDisabled={!plugin.installed_by_us}
            />
            {!plugin.installed_by_us && (
              <span className="plg-meta">{t("settings.plugins.notOurs")}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function IssueRow({ issue }: { issue: PluginIssue }) {
  const isError = issue.level === "error";
  return (
    <li className={isError ? "plg-issue plg-issue--err" : "plg-issue"}>
      {isError ? <WarningCircle size={13} weight="bold" /> : <Warning size={13} weight="bold" />}
      <span>
        <strong>{issue.target ?? issue.scope}</strong> — {issue.message}
      </span>
    </li>
  );
}
