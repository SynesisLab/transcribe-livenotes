import React, { useState } from 'react';

// Settings menu for everything Ollama-powered: the model choice plus, for
// advanced users, generation parameters (temperature etc.) sent with every
// AI call. All settings are app-wide. An empty advanced field means "use the
// model's own default" — the server only stores the values that are set.
const FIELDS = [
  {
    key: 'temperature',
    label: 'Temperature',
    step: '0.05',
    min: 0,
    max: 2,
    hint: 'Creativity: higher → more varied output, lower → more focused and deterministic.',
  },
  {
    key: 'top_p',
    label: 'Top P',
    step: '0.05',
    min: 0,
    max: 1,
    hint: 'Nucleus sampling — only tokens whose cumulative probability stays under this are considered.',
  },
  {
    key: 'top_k',
    label: 'Top K',
    int: true,
    min: 1,
    hint: 'Only the K most likely tokens are considered per step.',
  },
  {
    key: 'repeat_penalty',
    label: 'Repeat penalty',
    step: '0.05',
    min: 0,
    max: 2,
    hint: 'How strongly repetition is discouraged. 1 disables; >1 penalizes it.',
  },
  {
    key: 'num_predict',
    label: 'Max output tokens',
    int: true,
    min: -1,
    hint: 'Hard cap on the length of each response. -1 = unlimited.',
  },
  {
    key: 'num_ctx',
    label: 'Context window',
    int: true,
    min: 512,
    hint: 'Prompt memory in tokens for every AI call. Auto-notes needs ~8192 — smaller values can truncate its long prompts.',
  },
  {
    key: 'seed',
    label: 'Seed',
    int: true,
    hint: 'Fixes the randomness for reproducible output. Leave blank for random.',
  },
];

export default function SettingsModal({ config, models, onClose, onSave }) {
  const initial = config.ollamaOptions || {};
  const [model, setModel] = useState(config.ollamaModel || '');
  const [values, setValues] = useState(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, initial[f.key] !== undefined ? String(initial[f.key]) : '']))
  );
  const [error, setError] = useState(null);
  const [advOpen] = useState(() => FIELDS.some((f) => initial[f.key] !== undefined)); // expanded when something is set

  const setField = (key) => (e) => setValues((v) => ({ ...v, [key]: e.target.value }));

  const save = () => {
    const options = {};
    for (const f of FIELDS) {
      const raw = values[f.key].trim();
      if (raw === '') continue; // blank = use the model's default
      const num = Number(raw);
      if (!Number.isFinite(num)) {
        setError(`${f.label} must be a number.`);
        return;
      }
      if (f.int && !Number.isInteger(num)) {
        setError(`${f.label} must be a whole number.`);
        return;
      }
      if (f.min !== undefined && num < f.min) {
        setError(`${f.label} must be at least ${f.min}.`);
        return;
      }
      if (f.max !== undefined && num > f.max) {
        setError(`${f.label} must be at most ${f.max}.`);
        return;
      }
      options[f.key] = num;
    }
    // one message carries the model + the full options set; the server echoes
    // the authoritative config back, which the modal's parent stores
    const patch = { ollamaOptions: options };
    if (model) patch.ollamaModel = model;
    onSave(patch);
    onClose();
  };

  const resetDefaults = () => {
    setValues(Object.fromEntries(FIELDS.map((f) => [f.key, ''])));
    setError(null);
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings">
        <header>
          <h3>AI settings</h3>
          <button className="btn" onClick={onClose} title="Close">✕</button>
        </header>
        <p className="modal-hint">
          Model and generation parameters for every AI feature — summaries, action items, polish and the live
          auto-notes. Settings apply app-wide; leave an advanced field empty to use the model's default.
        </p>

        <div className="settings-form">
          <label>
            Ollama model
            <select
              className="model-select settings-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              title="Model used for all AI features"
            >
              {models.length === 0 && <option value="">no models found</option>}
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>

          <details className="adv-params" open={advOpen}>
            <summary>Advanced — sampling &amp; runtime parameters</summary>
            <div className="settings-grid">
              {FIELDS.map((f) => (
                <label key={f.key} className="setting-cell">
                  <span>{f.label}</span>
                  <input
                    type="number"
                    value={values[f.key]}
                    onChange={setField(f.key)}
                    placeholder="default"
                    step={f.step || '1'}
                    min={f.min}
                    max={f.max}
                    title={f.hint}
                  />
                </label>
              ))}
            </div>
            <p className="settings-note">
              Advanced parameters are sent with every Ollama call. “Context window” also bounds the auto-notes
              prompts — keep it ≈ 8192 or higher for long sessions.
            </p>
          </details>

          {error && <p className="form-error">{error}</p>}
          <div className="form-actions">
            <button className="btn danger-ghost" onClick={resetDefaults} title="Clear all advanced parameters">
              Reset to defaults
            </button>
            <span className="spacer" />
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={save}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}