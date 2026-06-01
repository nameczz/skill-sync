import { Command } from "cmdk";
import { Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle
} from "./ui/dialog";
import type { TFunction } from "../i18n";

export type CommandPaletteAction = {
  id: string;
  label: string;
  description?: string;
  group: string;
  disabled?: boolean;
  keywords?: string[];
  onSelect: () => void;
};

type CommandPaletteProps = {
  actions: CommandPaletteAction[];
  open: boolean;
  t: TFunction;
  onOpenChange: (open: boolean) => void;
};

export function CommandPalette({ actions, open, t, onOpenChange }: CommandPaletteProps) {
  const groups = Array.from(new Set(actions.map((action) => action.group)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogContent className="command-dialog" aria-labelledby="command-title" aria-describedby="command-description">
          <DialogHeader className="command-header">
            <div>
              <DialogTitle id="command-title">{t("commandPalette")}</DialogTitle>
              <DialogDescription id="command-description">{t("searchNavigationActions")}</DialogDescription>
            </div>
            <kbd>⌘K</kbd>
          </DialogHeader>
          <Command className="command-root" shouldFilter>
            <div className="command-input-row">
              <Search size={16} aria-hidden="true" />
              <Command.Input autoFocus placeholder={t("searchCommands")} />
            </div>
            <Command.List className="command-list">
              <Command.Empty className="command-empty">{t("noCommandFound")}</Command.Empty>
              {groups.map((group) => (
                <Command.Group heading={group} key={group}>
                  {actions
                    .filter((action) => action.group === group)
                    .map((action) => (
                      <Command.Item
                        key={action.id}
                        value={[action.label, action.description, ...(action.keywords ?? [])].filter(Boolean).join(" ")}
                        disabled={action.disabled}
                        onSelect={() => {
                          if (action.disabled) {
                            return;
                          }
                          action.onSelect();
                          onOpenChange(false);
                        }}
                      >
                        <span>{action.label}</span>
                        {action.description ? <small>{action.description}</small> : null}
                      </Command.Item>
                    ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
