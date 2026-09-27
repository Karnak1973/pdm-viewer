/**
 * Configuración persistente de las reglas del linter.
 *
 * Cada regla puede tener severidad error/warning/info u 'off'.
 * Se guarda en localStorage.
 */

import { create } from 'zustand';
import { defaultRuleConfig, RULES } from '../utils/rules';
import type { RuleConfig, RuleSeverity } from '../utils/rules';

const STORAGE_KEY = 'pdm-rule-config';

function load(): RuleConfig {
  const fallback = defaultRuleConfig();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return fallback;

    const config: RuleConfig = { ...fallback };
    const entries = parsed as Record<string, unknown>;
    const validSeverities = new Set(['error', 'warning', 'info', 'off']);

    for (const rule of RULES) {
      const value = entries[rule.id];
      if (typeof value === 'string' && validSeverities.has(value)) {
        config[rule.id] = value as RuleSeverity;
      }
    }
    return config;
  } catch {
    return fallback;
  }
}

function save(config: RuleConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // almacenamiento no disponible
  }
}

interface RuleConfigState {
  config: RuleConfig;
  setSeverity: (ruleId: string, severity: RuleSeverity) => void;
  toggleRule: (ruleId: string) => void;
  resetAll: () => void;
}

export const useRuleConfigStore = create<RuleConfigState>((set, get) => ({
  config: load(),

  setSeverity: (ruleId, severity) => {
    const next = { ...get().config, [ruleId]: severity };
    save(next);
    set({ config: next });
  },

  toggleRule: (ruleId) => {
    const current = get().config[ruleId];
    const severity: RuleSeverity = current === 'off' ? 'warning' : 'off';
    const next: RuleConfig = { ...get().config, [ruleId]: severity };
    save(next);
    set({ config: next });
  },

  resetAll: () => {
    const next = defaultRuleConfig();
    save(next);
    set({ config: next });
  },
}));
