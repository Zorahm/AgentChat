import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Atom, Lightning, Desktop, Brain, Code, CloudArrowDown, CheckCircle, WarningCircle, ArrowClockwise, X } from "@phosphor-icons/react";
import { VStack, HStack } from "@astryxdesign/core/Stack";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Section } from "@astryxdesign/core/Section";
import { Card } from "@astryxdesign/core/Card";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Divider } from "@astryxdesign/core/Divider";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Grid } from "@astryxdesign/core/Grid";
import { Link } from "@astryxdesign/core/Link";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { checkForUpdate, installUpdate, type UpdateStatus } from "../../../utils/updater";
import { isTauri } from "../../../utils/tauri";
import pkg from "../../../../package.json";
import avatarZorahm from "../../../assets/avatar-zorahm.png";
import avatarHerman from "../../../assets/avatar-hermandebush.png";

export function AboutTab({ onStartGhostChat }: { onStartGhostChat?: () => void }) {
  const { t } = useTranslation();
  const [ghostClicks, setGhostClicks] = useState(0);
  const stack = [
    { name: "React", icon: <Atom />, desc: t("settings.about.stackReact") },
    { name: "TypeScript", icon: <Code />, desc: t("settings.about.stackTypescript") },
    { name: "FastAPI", icon: <Lightning />, desc: t("settings.about.stackFastapi") },
    { name: "LiteLLM", icon: <Brain />, desc: t("settings.about.stackLiteLLM") },
    { name: "Tauri", icon: <Desktop />, desc: t("settings.about.stackTauri") },
    { name: "Python", icon: <Code />, desc: t("settings.about.stackPython") },
  ];

  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const dl = useRef({ done: 0, total: 0 });

  const busy = status.state === "checking" || status.state === "downloading" || status.state === "installing";
  const cardOpen = status.state !== "idle";

  const handleCheck = async () => {
    if (busy) return;
    setStatus({ state: "checking" });
    setStatus(await checkForUpdate());
  };

  const handleInstall = async () => {
    dl.current = { done: 0, total: 0 };
    await installUpdate((s) => {
      if (s.state === "downloading") {
        if (s.total) dl.current.total = s.total;
        dl.current.done += s.progress;
        const pct = dl.current.total ? Math.round((dl.current.done / dl.current.total) * 100) : 0;
        setStatus({ state: "downloading", progress: pct });
      } else {
        setStatus(s);
      }
    });
  };

  const closeCard = () => setStatus({ state: "idle" });

  const renderUpdateContent = () => {
    switch (status.state) {
      case "checking":
        return (
          <HStack gap={2} align="center">
            <ArrowClockwise className="spin" />
            <Text>{t("settings.about.checking")}</Text>
          </HStack>
        );
      case "available":
        return (
          <VStack gap={3}>
            <HStack gap={2} align="center" justify="between">
              <HStack gap={2} align="center">
                <CloudArrowDown />
                <Text weight="semibold">{t("settings.about.updateAvailable")}</Text>
              </HStack>
              <IconButton label={t("settings.about.close")} icon={<X />} onClick={closeCard} variant="ghost" size="sm" />
            </HStack>
            <Text color="secondary">{t("settings.about.updateTo", { from: pkg.version, to: status.version })}</Text>
            {status.body && <Text type="supporting">{status.body}</Text>}
            <Button label={t("settings.about.updateAndRestart")} onClick={handleInstall} variant="primary" />
          </VStack>
        );
      case "downloading":
        return (
          <VStack gap={2}>
            <HStack gap={2} align="center">
              <ArrowClockwise className="spin" />
              <Text>{t("settings.about.downloading")} {status.progress}%</Text>
            </HStack>
            <ProgressBar value={status.progress ?? 0} max={100} label="download" hasValueLabel />
          </VStack>
        );
      case "installing":
        return (
          <HStack gap={2} align="center">
            <ArrowClockwise className="spin" />
            <Text>{t("settings.about.installing")}</Text>
          </HStack>
        );
      case "latest":
        return (
          <HStack gap={2} align="center" justify="between">
            <HStack gap={2} align="center">
              <CheckCircle />
              <Text>{t("settings.about.latestVersion")}</Text>
            </HStack>
            <IconButton label={t("settings.about.close")} icon={<X />} onClick={closeCard} variant="ghost" size="sm" />
          </HStack>
        );
      case "error":
        return (
          <HStack gap={2} align="center" justify="between">
            <HStack gap={2} align="center">
              <WarningCircle />
              <Text>{status.message}</Text>
            </HStack>
            <IconButton label={t("settings.about.close")} icon={<X />} onClick={closeCard} variant="ghost" size="sm" />
          </HStack>
        );
      default:
        return null;
    }
  };

  return (
    <Section variant="transparent" padding={4}>
      <VStack gap={4}>
        <VStack gap={1}>
          <Heading level={2}>{t("settings.about.title")}</Heading>
          <Text type="body" color="secondary">{t("settings.about.description")}</Text>
        </VStack>

        <VStack gap={2}>
          <Heading level={3}>{t("settings.about.stack")}</Heading>
          <Grid columns={{ minWidth: 200 }} gap={2}>
            {stack.map((s) => (
              <Card key={s.name} padding={3}>
                <HStack gap={2} align="start">
                  <Text color="accent">{s.icon}</Text>
                  <VStack gap={0.5}>
                    <Text weight="semibold">{s.name}</Text>
                    <Text type="supporting">{s.desc}</Text>
                  </VStack>
                </HStack>
              </Card>
            ))}
          </Grid>
        </VStack>

        <VStack gap={2}>
          <Heading level={3}>{t("settings.about.authors")}</Heading>
          <VStack gap={3}>
            <HStack gap={3} align="center">
              <Avatar src={avatarZorahm} name="ZorahM" size="medium" />
              <VStack gap={0.5}>
                <Link href="https://github.com/zorahm" target="_blank" rel="noopener noreferrer" isExternalLink>
                  ZorahM
                </Link>
                <Text type="supporting">{t("settings.about.authorBackend")}</Text>
              </VStack>
            </HStack>
            <HStack gap={3} align="center">
              <Avatar src={avatarHerman} name="Herman" size="medium" />
              <VStack gap={0.5}>
                <Link href="https://github.com/hermandebush" target="_blank" rel="noopener noreferrer" isExternalLink>
                  Herman
                </Link>
                <Text type="supporting">{t("settings.about.authorUx")}</Text>
              </VStack>
            </HStack>
          </VStack>
        </VStack>

        <VStack gap={2}>
          <Heading level={3}>{t("settings.about.goal")}</Heading>
          <Text type="body">{t("settings.about.goalText")}</Text>
        </VStack>

        <Divider />

        <HStack gap={3} align="center" justify="between">
          <HStack gap={3} align="center">
            <div style={{ position: "relative", width: 36, height: 36 }}>
              {ghostClicks >= 5 && onStartGhostChat && (
                <Button
                  label="????"
                  onClick={onStartGhostChat}
                  variant="secondary"
                  size="sm"
                  className="st2-ghost-btn revealed"
                >
                  +
                </Button>
              )}
              <img
                src="/dots.svg"
                alt=""
                onClick={() => setGhostClicks(c => c + 1)}
                className={ghostClicks >= 5 ? "st2-ghost-fall" : ""}
                style={{ position: "absolute", inset: 0, width: 36, height: 36, borderRadius: 7, zIndex: 2 }}
              />
            </div>
            <VStack gap={0}>
              <Text weight="semibold">{t("settings.about.appName")}</Text>
              <Text type="supporting">{t("settings.about.version")} {pkg.version}</Text>
            </VStack>
          </HStack>
          {isTauri() && (
            <Button
              label={status.state === "checking" ? t("settings.about.checking") : t("settings.about.checkUpdates")}
              icon={<ArrowClockwise className={busy ? "spin" : ""} />}
              onClick={handleCheck}
              isDisabled={busy}
              isLoading={busy}
              variant="secondary"
            />
          )}
        </HStack>

        {isTauri() && cardOpen && (
          <Card padding={3}>
            {renderUpdateContent()}
          </Card>
        )}
      </VStack>
    </Section>
  );
}
