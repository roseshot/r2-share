import { useEffect, useState } from "react";
import { Toaster, toast } from "sonner";

function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function Notifications() {
  const [theme, setTheme] = useState(currentTheme);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return <Toaster position="bottom-right" theme={theme} richColors closeButton
    duration={4000} visibleToasts={3} />;
}

export function successToast(message: string, accessCode?: string | null) {
  if (!accessCode) {
    toast.success(message);
    return;
  }

  toast.success(message, {
    description: "Access code: " + accessCode,
    duration: 15000,
    action: {
      label: "Copy code",
      onClick: () => {
        void navigator.clipboard.writeText(accessCode)
          .then(() => toast.success("Access code copied"))
          .catch(() => toast.error("Unable to copy access code", { duration: 8000 }));
      },
    },
  });
}

export function errorToast(message: string) {
  toast.error(message, { duration: 8000 });
}
