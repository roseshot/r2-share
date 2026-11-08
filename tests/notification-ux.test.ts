import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) =>
  readFileSync(new URL("../" + path, import.meta.url), "utf8");

describe("feedback and confirmation UX", () => {
  test("mounts one Sonner notification center at the app root", () => {
    const main = read("src/main.tsx");
    const notifications = read("src/components/notifications.tsx");
    expect(main).toContain("<Notifications />");
    expect(notifications).toContain('from "sonner"');
    expect(notifications).toContain('position="bottom-right"');
    expect(notifications).toContain("MutationObserver");
    expect(notifications).toContain("Copy code");
    expect(notifications).toContain("duration: 15000");
    expect(notifications).toContain("duration: 8000");
  });

  test("uses an accessible confirmation dialog for destructive operations", () => {
    const confirmation = read("src/components/confirm-dialog.tsx");
    expect(confirmation).toContain('from "@base-ui/react/alert-dialog"');
    expect(confirmation).toContain("<AlertDialog.Title");
    expect(confirmation).toContain("<AlertDialog.Description");
    expect(confirmation).toContain("<AlertDialog.Close");
    expect(confirmation).toContain("if (!pending) onOpenChange(next)");
    for (const file of ["src/pages/admin.tsx", "src/features/admin/admin-shares.tsx", "src/features/admin/admin-settings.tsx"]) {
      const content = read(file);
      expect(content).toContain("<ConfirmDialog");
      expect(content).not.toContain("window.confirm(");
    }
  });

  test("preserves inline form errors, file upload progress, and empty-state guidance", () => {
    for (const path of ["src/pages/admin.tsx", "src/features/admin/admin-shares.tsx", "src/features/admin/admin-settings.tsx"]) {
      expect(read(path)).toContain('role="alert"');
    }
    expect(read("src/pages/home.tsx")).toContain('role="alert"');
    expect(read("src/pages/share.tsx")).toContain('role="alert"');
    const admin = read("src/pages/admin.tsx");
    expect(admin).toContain("xhr.upload.onprogress");
    expect(admin).toContain("Upload progress");
    expect(admin).toContain("No files yet");
    expect(read("src/features/admin/admin-settings.tsx")).toContain("No storage configured");
    expect(read("src/features/admin/admin-shares.tsx")).toContain("No share links yet");
  });

  test("shows success toasts instead of retaining success banners", () => {
    for (const path of ["src/pages/admin.tsx", "src/features/admin/admin-shares.tsx", "src/features/admin/admin-settings.tsx"]) {
      const content = read(path);
      expect(content).toContain("successToast(");
      expect(content).not.toContain("setMessage(");
    }
    expect(JSON.parse(read("package.json")).dependencies.sonner).toBeDefined();
  });
});
