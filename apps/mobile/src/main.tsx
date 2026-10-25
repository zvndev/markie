import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import "./styles.css";
import { MarkieMobileApp } from "./app";
import { fetchTransport } from "./lib/http";
import { nativeTransport } from "./lib/native-http";
import { platformSecureStore } from "./lib/secure-store";
import { paintTone, loadThemeMode, resolveTone, systemPrefersDark } from "./lib/theme-mode";

const native = Capacitor.isNativePlatform();
document.documentElement.dataset.platform = Capacitor.getPlatform();
// Paint before the first frame so a launch never flashes the wrong tone.
paintTone(resolveTone(loadThemeMode(), systemPrefersDark()));

createRoot(document.getElementById("root")!).render(
  <MarkieMobileApp
    native={native}
    transport={native ? nativeTransport() : fetchTransport()}
    secure={platformSecureStore(native)}
  />
);
