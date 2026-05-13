// @refresh reload
import { mount, StartClient } from "@solidjs/start/client";

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("#app root element missing from index document");
mount(() => <StartClient />, appRoot);
