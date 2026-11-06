import { useState, type FormEvent } from "react";
import { ArrowRight } from "lucide-react";
import { Button, Input } from "./ui";
import { resolveSharePath } from "./routes";
import { ThemeSwitcher } from "./theme";

export default function Home() {
  const [link, setLink] = useState("");
  const [error, setError] = useState("");

  function openShare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const path = resolveSharePath(link, window.location.origin);
    if (!path) {
      setError("Enter a valid share link or file ID from this site.");
      return;
    }
    window.location.assign(path);
  }

  return (
    <main className="relative flex min-h-screen flex-col overflow-hidden px-5 sm:px-8">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-96 bg-[radial-gradient(ellipse_at_50%_0%,rgba(16,185,129,.12),transparent_70%)]" />
      <header className="relative mx-auto flex w-full max-w-5xl items-center gap-3 py-7">
        <img src="/tuckbox-mark.svg" width="40" height="40" className="size-10" alt="" aria-hidden="true" />
        <span className="text-lg font-semibold tracking-tight">TuckBox</span>
        <div className="ml-auto"><ThemeSwitcher /></div>
      </header>

      <section className="relative mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center pb-24 text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50 sm:text-5xl">
          Private file sharing
        </h1>
        <p className="mt-4 text-sm leading-7 text-zinc-600 dark:text-zinc-400 sm:text-base">
          Share files privately through a link.
        </p>

        <form className="mt-10 w-full max-w-md" onSubmit={openShare}>
          <label htmlFor="share-link" className="sr-only">Share link or file ID</label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Input
              id="share-link"
              value={link}
              onChange={event => {
                setLink(event.target.value);
                if (error) setError("");
              }}
              placeholder="Share link or file ID"
              autoComplete="off"
              spellCheck={false}
              required
            />
            <Button type="submit" className="shrink-0">
              Open <ArrowRight size={17} aria-hidden="true" />
            </Button>
          </div>
          {error && <p role="alert" className="mt-3 text-left text-sm text-red-700 dark:text-red-300">{error}</p>}
        </form>
      </section>
    </main>
  );
}
