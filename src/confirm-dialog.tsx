import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Button, buttonStyles } from "./ui";

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, pending,
  onConfirm, error }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => void;
  error?: string;
}) {
  return <AlertDialog.Root open={open} onOpenChange={next => { if (!pending) onOpenChange(next); }}>
    <AlertDialog.Portal>
      <AlertDialog.Backdrop className="fixed inset-0 z-60 bg-black/60" />
      <AlertDialog.Popup
        className="fixed left-1/2 top-1/2 z-70 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-zinc-200 bg-white p-6 text-zinc-950 shadow-2xl outline-none dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-50"
      >
        <AlertDialog.Title className="text-lg font-semibold">{title}</AlertDialog.Title>
        <AlertDialog.Description className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          {description}
        </AlertDialog.Description>
        {error && <p role="alert" className="mt-4 rounded-xl bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
        <div className="mt-6 flex justify-end gap-3">
          <AlertDialog.Close disabled={pending} className={buttonStyles({ variant: "secondary", size: "sm" })}>
            Cancel
          </AlertDialog.Close>
          <Button size="sm" variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending ? "Working…" : confirmLabel}
          </Button>
        </div>
      </AlertDialog.Popup>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
}
