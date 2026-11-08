import { useEffect, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { Check, Monitor, Moon, Sun } from "lucide-react";

export type ThemePreference = "system" | "light" | "dark";
const storageKey = "tuckbox-theme";

export function resolveTheme(preference: ThemePreference, systemIsDark: boolean): "light" | "dark" {
  return preference === "system" ? (systemIsDark ? "dark" : "light") : preference;
}

export function readThemePreference(value: string | null): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

function storedPreference(): ThemePreference {
  try { return readThemePreference(localStorage.getItem(storageKey)); }
  catch { return "system"; }
}

const choices = [
  { value: "system" as const, label: "System", icon: Monitor },
  { value: "light" as const, label: "Light", icon: Sun },
  { value: "dark" as const, label: "Dark", icon: Moon },
];

export function ThemeSwitcher() {
  const [preference, setPreference] = useState<ThemePreference>(storedPreference);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    function applyTheme() {
      document.documentElement.dataset.theme = resolveTheme(preference, media.matches);
    }
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [preference]);

  function selectTheme(next: ThemePreference) {
    setPreference(next);
    try {
      if (next === "system") localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, next);
    } catch { /* The appearance setting still works in this tab. */ }
  }

  const current = choices.find(choice => choice.value === preference)!;
  const CurrentIcon = current.icon;
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Appearance"
        title={"Appearance: " + current.label}
        className="grid size-10 shrink-0 place-items-center rounded-xl border border-zinc-200 bg-zinc-100/80 text-zinc-700 transition hover:bg-zinc-200 dark:border-white/10 dark:bg-zinc-900/75 dark:text-zinc-300 dark:hover:bg-white/10"
      >
        <CurrentIcon size={18} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} align="end" className="z-50">
          <Menu.Popup
            aria-label="Appearance"
            className="min-w-40 rounded-xl border border-zinc-200 bg-white p-1.5 text-zinc-800 shadow-xl outline-none dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-100"
          >
            {choices.map(({ value, label, icon: Icon }) => (
              <Menu.Item
                key={value}
                onClick={() => selectTheme(value)}
                className="flex cursor-default items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none data-highlighted:bg-zinc-100 dark:data-highlighted:bg-white/10"
              >
                <Icon size={16} aria-hidden="true" />
                {label}
                {preference === value && <Check size={15} className="ml-auto text-emerald-600 dark:text-emerald-300" aria-hidden="true" />}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
