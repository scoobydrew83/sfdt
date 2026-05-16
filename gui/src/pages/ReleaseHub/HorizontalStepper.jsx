import {
  IconPackage, IconBook, IconFileEdit, IconShield, IconRocket, IconRotateCcw,
} from '../../Icons.jsx';
export const STEPS = [
  { id: 'manifest',  label: 'Target',        Icon: IconPackage  },
  { id: 'changelog', label: 'Changelog',      Icon: IconBook     },
  { id: 'notes',     label: 'Release Notes',  Icon: IconFileEdit },
  { id: 'validate',  label: 'Validate',       Icon: IconShield   },
  { id: 'deploy',    label: 'Deploy',         Icon: IconRocket   },
  { id: 'rollback',  label: 'Rollback',       Icon: IconRotateCcw},
];
export default function HorizontalStepper({ active, done, onSelect }) {
  return (
    <div className="stepper">
      {STEPS.map((step, i) => {
        const isActive = active === step.id;
        const isDone   = done.has(step.id);
        const cls      = isDone ? 'step done' : isActive ? 'step active' : 'step pending';
        return (
          <button
            key={step.id}
            className={cls}
            onClick={() => onSelect(step.id)}
            style={{ background: 'none', border: 'none', padding: 0 }}
          >
            <span className="step-ring">
              {isDone ? '✓' : i + 1}
            </span>
            <span className="step-lbl">{step.label}</span>
          </button>
        );
      })}
    </div>
  );
}
