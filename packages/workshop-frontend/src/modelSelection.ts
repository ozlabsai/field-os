import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";

const LAST_SELECTED_MODEL_KEY = "lastSelectedModel";

// Set alongside the sentinel when the user picks "No agent" from a dropdown. Its ABSENCE beside a
// stored sentinel means the sentinel predates the OZL-313 fix, when onboarding wrote it for
// "the deployment had no models yet" -- a fact about a moment, recorded as a permanent decision
// about the user. Those are cleared once, below; a marked sentinel is a real choice and is kept.
const NO_AGENT_EXPLICIT_KEY = "lastSelectedModelNoAgentExplicit";

// Sentinel used for UI values and localStorage so an explicit null choice can persist.
export const NO_AGENT_OPTION_VALUE = "__gadgets_no_agent__";

export function getStoredSelectedModel(
  models: AiChatAuthorInfo[],
): string | null {
  const storedModel = localStorage.getItem(LAST_SELECTED_MODEL_KEY);

  if (storedModel === NO_AGENT_OPTION_VALUE) {
    // One-time migration for sentinels written before OZL-313 was fixed. Unmarked ones came from
    // onboarding running with no models configured, and left the user sending every message
    // unanswered forever with no way to know a fix had shipped. Clearing lets the fallback below
    // resolve a model; a marked sentinel is a deliberate "don't answer" and is honoured.
    if (localStorage.getItem(NO_AGENT_EXPLICIT_KEY) === "1") return null;
    localStorage.removeItem(LAST_SELECTED_MODEL_KEY);
  } else if (storedModel && models.some((model) => model.id === storedModel)) {
    return storedModel;
  }

  // Default: Return the first configured model, or null if none are configured.
  return models[0]?.id ?? null;
}

export function persistSelectedModel(modelId: string | null): void {
  localStorage.setItem(
    LAST_SELECTED_MODEL_KEY,
    modelId ?? NO_AGENT_OPTION_VALUE,
  );
  // Mark a null as deliberate. Every caller of this function is now an explicit user pick from a
  // dropdown (OnboardingWizard persists only a real choice since OZL-313), so reaching here with
  // null means the user chose it.
  if (modelId === null) localStorage.setItem(NO_AGENT_EXPLICIT_KEY, "1");
  else localStorage.removeItem(NO_AGENT_EXPLICIT_KEY);
}

export function toModelSelectValue(modelId: string | null): string {
  return modelId ?? NO_AGENT_OPTION_VALUE;
}

export function fromModelSelectValue(value: string): string | null {
  return value === NO_AGENT_OPTION_VALUE ? null : value;
}
