import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import "./styles.css";
import { MarkieMobileApp } from "./app";
import { fetchTransport } from "./lib/http";
import { nativeTransport } from "./lib/native-http";
import { platformSecureStore } from "./lib/secure-store";
import { sweepShareFiles } from "./lib/native";
import { startTextSize } from "./lib/text-size";
import { paintTone, loadThemeMode, resolveTone, systemPrefersDark } from "./lib/theme-mode";

const native = Capacitor.isNativePlatform();
document.documentElement.dataset.platform = Capacitor.getPlatform();
// Paint before the first frame so a launch never flashes the wrong tone.
paintTone(resolveTone(loadThemeMode(), systemPrefersDark()));
// The system's text size, now and whenever the app comes back to the front.
startTextSize(Capacitor.getPlatform());
// A file exported for the share sheet never outlives the launch after it.
void sweepShareFiles();

createRoot(document.getElementById("root")!).render(
  <MarkieMobileApp
    native={native}
    transport={native ? nativeTransport() : fetchTransport()}
    secure={platformSecureStore(native)}
  />
);
