import { SceneActionButton } from "./SceneActionButton";
export function OrbitViewMenu({
  locked,
  disabled,
  onTopDown,
  onResetView,
  onToggleLock,
  wallDisplay,
  onClose,
}: {
  locked: boolean;
  disabled: boolean;
  onTopDown: (() => void) | undefined;
  onResetView: (() => void) | undefined;
  onToggleLock: (() => void) | undefined;
  /** Device-local Wall display toggle; omitted where the dashboard does not offer it. */
  wallDisplay?: { enabled: boolean; onToggle: () => void } | undefined;
  onClose: () => void;
}) {
  return (
    <>
      {" "}
      {[
        {
          label: "Top-down",
          action: onTopDown,
          active: false,
          path: "M4 4h16v16H4zM4 12h8v8M12 4v8h8",
        },
        {
          label: "Reset view",
          action: onResetView,
          active: false,
          path: "M4 10a8 8 0 1 1 1 8M4 4v6h6",
        },
        {
          label: "Lock view",
          action: onToggleLock,
          active: locked,
          path: "M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4",
        },
        {
          label: "Wall display",
          action: wallDisplay?.onToggle,
          active: wallDisplay?.enabled ?? false,
          path: "M3 4h18v13H3zM8 21h8M12 17v4",
        },
      ].map(
        ({ label, action, active, path }) =>
          action && (
            <SceneActionButton
              key={label}
              label={label}
              active={active}
              disabled={disabled}
              icon={
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d={path} />
                </svg>
              }
              onClick={() => {
                action();
                onClose();
              }}
            />
          ),
      )}
    </>
  );
}
