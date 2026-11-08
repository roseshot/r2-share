import { StrictMode, Suspense, lazy, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { routeForPath, type Route } from "./lib/routes";
import { Notifications } from "./components/notifications";
import "./style.css";

const Home = lazy(() => import("./pages/home"));
const Admin = lazy(() => import("./pages/admin"));
const SharePage = lazy(() => import("./pages/share"));
const PublicUploadPage = lazy(() => import("./pages/public-upload"));

const initialRoute = routeForPath(location.pathname);
const needsAdminCheck = initialRoute === "share"; // Probe every single-segment path: admin entries can have any length.

function App() {
  const [route, setRoute] = useState<Route | "checking">(needsAdminCheck ? "checking" : initialRoute);

  useEffect(() => {
    if (!needsAdminCheck) return;
    // Distinguish the private admin path from an invalid or unknown share ID
    // without exposing ADMIN_PATH. Both render the same HTML shell.
    const controller = new AbortController();
    fetch(location.pathname + "/api/session", {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    }).then(response => {
      if (!controller.signal.aborted) {
        setRoute(routeForPath(location.pathname, response.status === 200 || response.status === 401));
      }
    }).catch(() => {
      if (!controller.signal.aborted) setRoute(initialRoute);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (route === "not-found") window.location.replace("/");
  }, [route]);

  return (
    <Suspense fallback={<div className="grid min-h-screen place-items-center text-sm text-zinc-500">Loading…</div>}>
      {route === "home" ? <Home /> : route === "share" ? <SharePage /> :
        route === "public-upload" ? <PublicUploadPage /> :
        route === "admin" ? <Admin /> : route === "checking" ?
          <div className="grid min-h-screen place-items-center text-sm text-zinc-500">Loading…</div> :
          null}
    </Suspense>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /><Notifications /></StrictMode>);
