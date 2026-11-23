// One Electron component in a named state, for headless screenshots.
// The page is /scene.html?scene=<name>&theme=<light|dark>&args=<json>.
// Sessions arrive in localStorage before this runs (shoot.mjs).
import "@/app/globals.css";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { applyColorMode } from "@/lib/color-mode";
import { ShareDialog } from "@/components/share-dialog";
import { DocumentCloudDialog } from "@/components/document-cloud-dialog";
import { Settings } from "@/components/settings";

const params = new URLSearchParams(location.search);
const scene = params.get("scene") ?? "";
const args = JSON.parse(params.get("args") ?? "{}");
applyColorMode(params.get("theme") === "dark" ? "dark" : "light");

function OfficeCloud() {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  useEffect(() => {
    fetch(`/@fs${args.file}`).then((r) => r.arrayBuffer()).then((b) => setBytes(new Uint8Array(b)));
  }, []);
  if (!bytes) return null;
  return <DocumentCloudDialog file={{ name: args.file.split("/").pop(), bytes }} onClose={() => {}} />;
}

function Scene() {
  if (scene === "share") {
    return <ShareDialog docId={args.doc_id} fileName={args.file_name} body={args.body ?? ""} onClose={() => {}} onChanged={() => {}} />;
  }
  if (scene === "office-cloud") return <OfficeCloud />;
  if (scene === "servers") return <Settings onClose={() => {}} initialSection="advanced" />;
  return <p>unknown scene {scene}</p>;
}

createRoot(document.getElementById("root")!).render(
  <div className="h-screen w-screen bg-background text-foreground">
    <Scene />
  </div>
);
document.body.dataset.sceneMounted = "1";
