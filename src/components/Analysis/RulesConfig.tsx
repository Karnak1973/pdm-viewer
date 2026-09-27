/**
 * Panel de configuración de reglas del linter.
 *
 * Permite cambiar la severidad de cada regla o desactivarla.
 */

import { useState } from 'react';
import { RULES, RULE_CATEGORY_LABELS } from '../../utils/rules';
import type { RuleCategory, RuleSeverity } from '../../utils/rules';
import { useRuleConfigStore } from '../../state/ruleConfigStore';

const SEVERITIES: { value: RuleSeverity; label: string }[] = [
  { value: 'error', label: 'Error' },
  { value: 'warning', label: 'Aviso' },
  { value: 'info', label: 'Info' },
  { value: 'off', label: 'Off' },
];

const CATEGORIES: RuleCategory[] = [
  'keys',
  'indexes',
  'naming',
  'types',
  'relations',
  'normalization',
];

export function RulesConfig() {
  const config = useRuleConfigStore((state) => state.config);
  const setSeverity = useRuleConfigStore((state) => state.setSeverity);
  const resetAll = useRuleConfigStore((state) => state.resetAll);
  const [open, setOpen] = useState(false);

  const activeCount = RULES.filter((rule) => config[rule.id] !== 'off').length;

  return (
    <div className="rules-config">
      <button
        type="button"
        className="rules-config__toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span>⚙ Reglas ({activeCount}/{RULES.length} activas)</span>
        <span className="rules-config__chevron">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="rules-config__body">
          <div className="rules-config__actions">
            <button type="button" onClick={resetAll}>
              Restaurar valores por defecto
            </button>
          </div>

          {CATEGORIES.map((category) => {
            const rules = RULES.filter((rule) => rule.category === category);
            if (rules.length === 0) return null;

            return (
              <div key={category} className="rules-config__category">
                <h4>{RULE_CATEGORY_LABELS[category]}</h4>
                <ul>
                  {rules.map((rule) => {
                    const current = config[rule.id] ?? rule.defaultSeverity;
                    return (
                      <li key={rule.id} className={current === 'off' ? 'off' : ''}>
                        <div className="rules-config__rule-info">
                          <strong>{rule.title}</strong>
                          <p>{rule.description}</p>
                        </div>
                        <div className="rules-config__severity">
                          {SEVERITIES.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              className={
                                current === option.value
                                  ? `sev-${option.value} active`
                                  : `sev-${option.value}`
                              }
                              onClick={() => setSeverity(rule.id, option.value)}
                              title={`Severidad: ${option.label}`}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
