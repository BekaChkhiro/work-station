import { Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Suspense } from "solid-js";
import { Shell } from "./components/Shell";
import "./app.css";

export default function App() {
  return (
    <Router
      root={(props) => (
        <Shell>
          <Suspense>{props.children}</Suspense>
        </Shell>
      )}
    >
      <FileRoutes />
    </Router>
  );
}
