import type { SettingsData } from "../SettingsPanel";

const MAX_ITER_MIN = 1;
const MAX_ITER_MAX = 500;

export function ModelsTab({ settings, loading, onUpdate, onRefresh }: {
  settings: SettingsData; loading: boolean;
  onUpdate: (p: Record<string, unknown>) => void;
  onRefresh: () => void;
}) {
  return <>
    <div className="st2-row-between">
      <div>
        <h3 className="st2-h">Модели</h3>
        <p className="st2-sub">Список загружается из /models у каждого провайдера.</p>
      </div>
      <button className="st2-btn" onClick={onRefresh} disabled={loading}>
        {loading ? "Обновляю…" : "Обновить"}
      </button>
    </div>
    <div className="st2-section">
      <h4>Модель по умолчанию</h4>
      <select className="st2-select" value={settings.default_model}
        onChange={(e) => onUpdate({ default_model: e.target.value })}>
        {settings.models.length === 0 && <option value="">— нет моделей —</option>}
        {settings.models.map((m) => <option key={m.id} value={m.id}>{m.name ?? m.id}</option>)}
      </select>
    </div>
    <div className="st2-section">
      <h4>Температура · {settings.temperature}</h4>
      <input type="range" min={0} max={2} step={0.1} value={settings.temperature}
        onChange={(e) => onUpdate({ temperature: Number(e.target.value) })}
        style={{ width: "100%", maxWidth: 300 }} />
    </div>
    <div className="st2-section">
      <h4>Макс. итераций агента (tool use)</h4>
      <input type="number" min={MAX_ITER_MIN} max={MAX_ITER_MAX} className="st2-num" value={settings.max_iterations}
        onChange={(e) => onUpdate({ max_iterations: Number(e.target.value) })} />
      <p className="st2-sub2">от {MAX_ITER_MIN} до {MAX_ITER_MAX}</p>
    </div>
  </>;
}
