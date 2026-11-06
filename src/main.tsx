import { StrictMode, Suspense, lazy, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { routeForPath, type Route } from "./routes";
import { Notifications } from "./notifications";
import "./style.css";

const Home = lazy(() => import("./home"));
const Admin = lazy(() => import("./admin"));
const SharePage = lazy(() => import("./share"));

const initialRoute = routeForPath(location.pathname);
const needsAdminCheck = initialRoute === "share";

function App() {
  const [route, setRoute] = useState<Route | "checking">(needsAdminCheck ? "checking" : initialRoute);

  useEffect(() => {
    if (!needsAdminCheck) return;
    // An admin entry may also be exactly 16 characters. Distinguish it by
    // probing the admin-only session endpoint, without exposing ADMIN_PATH.
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

  return (
    <Suspense fallback={<div className="grid min-h-screen place-items-center text-sm text-zinc-500">Loading…</div>}>
      {route === "home" ? <Home /> : route === "share" ? <SharePage /> :
        route === "admin" ? <Admin /> : route === "checking" ?
          <div className="grid min-h-screen place-items-center text-sm text-zinc-500">Loading…</div> :
          <div className="grid min-h-screen place-items-center text-sm text-zinc-500">404 · Page not found</div>}
    </Suspense>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /><Notifications /></StrictMode>);
