// Local AI via the ZVN inference gateway (OpenAI-compatible /v1 API).
// No paid SDKs: plain fetch against the configured gateway; the key lives
// in localStorage and never leaves the machine except to that gateway.

export interface AIConfig {
  url: string;
  key: string;
  model: string;
}

const AI_KEY = "markie.ai.v1";
export const DEFAULT_AI_URL = "https://inference.zvndev.com";

export function getAIConfig(): AIConfig {
  try {
    const raw = localStorage.getItem(AI_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AIConfig>;
      return {
        url: parsed.url || DEFAULT_AI_URL,
        key: parsed.key || "",
        model: parsed.model || "auto",
      };
    }
  } catch {
    // fall through
  }
  return { url: DEFAULT_AI_URL, key: "", model: "auto" };
}

export function setAIConfig(cfg: AIConfig): void {
  try {
    localStorage.setItem(AI_KEY, JSON.stringify(cfg));
  } catch {
    // storage unavailable
  }
}

export function aiConfigured(): boolean {
  return !!getAIConfig().key;
}

export async function aiChat(system: string, user: string): Promise<string> {
  const cfg = getAIConfig();
  if (!cfg.key) {
    throw new Error("Add your inference gateway key in Settings → AI first.");
  }
  const res = await fetch(`${cfg.url.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.key}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gateway error ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Gateway returned no content.");
  return content.trim();
}

export const AI_TASKS = {
  summarize: {
    title: "Summarize Document",
    system:
      "You summarize markdown documents. Reply with a tight markdown summary: 2-4 sentences, then up to 5 key bullet points. No preamble.",
  },
  rewrite: {
    title: "Rewrite Selection",
    system:
      "You rewrite markdown passages to be clearer and tighter without changing meaning or markdown structure. Reply with only the rewritten passage. No preamble.",
  },
} as const;

export type AITaskKind = keyof typeof AI_TASKS;
