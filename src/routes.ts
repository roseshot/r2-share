export type Route = "home" | "share" | "admin" | "public-upload" | "not-found";

const sharePath = /^\/[A-Za-z0-9_-]{16}$/;
const singleSegmentPath = /^\/[a-zA-Z0-9_-]+$/;

export function routeForPath(path: string, isAdminEntry = false): Route {
  if (path === "/") return "home";
  if (/^\/u\/[A-Za-z0-9_-]{16}$/.test(path)) return "public-upload";
  if (singleSegmentPath.test(path)) return isAdminEntry ? "admin" : "share";
  return "not-found";
}

export function resolveSharePath(input: string, origin: string): string | null {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]{16}$/.test(value)) return "/" + value;
  try {
    const url = new URL(value, origin);
    return url.origin === origin && sharePath.test(url.pathname) ? url.pathname : null;
  } catch {
    return null;
  }
}
