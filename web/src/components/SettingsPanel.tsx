import type { ReactNode } from "react";
import { FolderGit2, FolderOpen, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import type { TFunction } from "../i18n";

export type SetupPaths = {
  syncRepo: string;
  codexSkillsDir: string;
  agentsSkillsDir: string;
  cacheDir: string;
};

export type SetupPathField = keyof SetupPaths | "setupRoot";

type SettingsPanelProps = {
  paths: SetupPaths;
  busyId: string | null;
  selectingPath: SetupPathField | null;
  t: TFunction;
  onPathChange: (field: keyof SetupPaths, value: string) => void;
  onChoose: (field: keyof SetupPaths, title: string) => void;
  onSave: () => void;
};

export function SettingsPanel({
  paths,
  busyId,
  selectingPath,
  t,
  onPathChange,
  onChoose,
  onSave
}: SettingsPanelProps) {
  const saving = busyId === "save-config";

  return (
    <Card className="settings-panel" aria-labelledby="settings-title">
      <CardHeader className="settings-head">
        <div>
          <p className="eyebrow">{t("localConfiguration")}</p>
          <CardTitle id="settings-title">{t("paths")}</CardTitle>
        </div>
        <Button variant="primary" type="button" onClick={onSave} disabled={saving}>
          {saving ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <FolderGit2 size={15} aria-hidden="true" />}
          {t("savePaths")}
        </Button>
      </CardHeader>

      <CardContent className="settings-paths">
        <PathSetting
          title={t("gitSyncRepository")}
          body={t("trackedByGit")}
          input={
            <PathInput
              id="settings-sync-repo-path"
              label={t("path")}
              value={paths.syncRepo}
              onChange={(value) => onPathChange("syncRepo", value)}
              onChoose={() => onChoose("syncRepo", t("chooseSyncRepositoryDirectory"))}
              choosing={selectingPath === "syncRepo"}
              chooseLabel={t("choose")}
            />
          }
        />
        <details className="advanced-settings">
          <summary>{t("advancedLocalPaths")}</summary>
          <div className="advanced-settings-body">
            <PathSetting
              title={t("codexSkillsDirectory")}
              body={t("codexSkillsDirectoryHelp")}
              input={
                <PathInput
                  id="settings-codex-skills-path"
                  label={t("path")}
                  value={paths.codexSkillsDir}
                  onChange={(value) => onPathChange("codexSkillsDir", value)}
                  onChoose={() => onChoose("codexSkillsDir", t("codexSkillsDirectory"))}
                  choosing={selectingPath === "codexSkillsDir"}
                  chooseLabel={t("choose")}
                />
              }
            />
            <PathSetting
              title={t("agentsSkillsDirectory")}
              body={t("agentsSkillsDirectoryHelp")}
              input={
                <PathInput
                  id="settings-agents-skills-path"
                  label={t("path")}
                  value={paths.agentsSkillsDir}
                  onChange={(value) => onPathChange("agentsSkillsDir", value)}
                  onChoose={() => onChoose("agentsSkillsDir", t("agentsSkillsDirectory"))}
                  choosing={selectingPath === "agentsSkillsDir"}
                  chooseLabel={t("choose")}
                />
              }
            />
            <PathSetting
              title={t("localCacheDirectory")}
              body={t("localCacheDirectoryHelp")}
              input={
                <PathInput
                  id="settings-cache-path"
                  label={t("path")}
                  value={paths.cacheDir}
                  onChange={(value) => onPathChange("cacheDir", value)}
                  onChoose={() => onChoose("cacheDir", t("localCacheDirectory"))}
                  choosing={selectingPath === "cacheDir"}
                  chooseLabel={t("choose")}
                />
              }
            />
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

function PathSetting({ title, body, input }: { title: string; body: string; input: ReactNode }) {
  return (
    <div className="path-setting">
      <div>
        <h3>{title}</h3>
        <p>{body}</p>
      </div>
      {input}
    </div>
  );
}

export function PathInput({
  id,
  label,
  value,
  onChange,
  onChoose,
  choosing,
  placeholder,
  chooseLabel = "Choose"
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onChoose: () => void;
  choosing: boolean;
  placeholder?: string;
  chooseLabel?: string;
}) {
  return (
    <div className="path-input">
      <label htmlFor={id}>{label}</label>
      <div className="path-input-row">
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          spellCheck={false}
        />
        <Button className="button secondary path-choose" variant="secondary" size="sm" type="button" onClick={onChoose} disabled={choosing}>
          {choosing ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <FolderOpen size={14} aria-hidden="true" />}
          {chooseLabel}
        </Button>
      </div>
    </div>
  );
}

export function PathSummary({ label, value }: { label: string; value: string }) {
  return (
    <div className="path-summary">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}
