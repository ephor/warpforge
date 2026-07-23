import { Maximize2, Minimize2 } from "lucide-react";

interface FocusButtonProps {
  focused: boolean;
  label: string;
  onClick: () => void;
}

export function FocusButton({ focused, label, onClick }: FocusButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
    >
      {focused ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
    </button>
  );
}
