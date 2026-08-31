import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { daemon } from "../daemon";
import { portRangeInputError } from "./projects/portRange";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdded?: (projectName: string) => void;
}

/** Extract the last path segment as a project name. */
function folderNameFromPath(p: string): string {
  const segments = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

export default function AddProjectDialog({ open, onOpenChange, onAdded }: Props) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [portRange, setPortRange] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const resetForm = () => {
    setPath("");
    setName("");
    setNameEdited(false);
    setPortRange("");
  };

  const handleBrowse = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Select project folder",
    });
    if (selected) {
      setPath(selected);
      if (!nameEdited) {
        setName(folderNameFromPath(selected));
      }
    }
  };

  const handlePathChange = (v: string) => {
    setPath(v);
    if (!nameEdited) {
      setName(folderNameFromPath(v));
    }
  };

  const handleAdd = async () => {
    if (!path.trim()) {
      setError("Path is required");
      return;
    }
    if (portRange.trim()) {
      setError(portRangeInputError(portRange) ?? null);
      if (portRangeInputError(portRange)) return;
    }
    setLoading(true);
    setError(null);
    try {
      // The range rides along with the add request as this machine's starting
      // ("sticky") assignment. It is not a local override: a `ports.range`
      // the team later declares in the project's config outranks it normally.
      const added = (await daemon.addProject(path.trim(), name.trim() || undefined, portRange.trim() || undefined)) as {
        name?: string;
      };
      const projectName = added?.name ?? name.trim();
      resetForm();
      onOpenChange(false);
      if (projectName) onAdded?.(projectName);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          resetForm();
          setError(null);
        }
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Project</DialogTitle>
          <DialogDescription>
            Register a folder as a Warpforge project. A{" "}
            <code className="text-foreground">.warpforge.yaml</code> config will be created if none
            exists.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div>
            <label
              htmlFor="project-path"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Folder path
            </label>
            <div className="flex gap-2">
              <input
                id="project-path"
                type="text"
                value={path}
                onChange={(e) => handlePathChange(e.target.value)}
                placeholder="/Users/you/projects/my-app"
                className="flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleAdd();
                  }
                }}
              />
              <Button variant="outline" size="sm" onClick={handleBrowse}>
                <FolderOpen className="mr-1 size-4" />
                Browse
              </Button>
            </div>
          </div>

          <div>
            <label
              htmlFor="project-name"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Name (optional)
            </label>
            <input
              id="project-name"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameEdited(true);
              }}
              placeholder="Auto-detected from folder name"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleAdd();
                }
              }}
            />
          </div>

          <div>
            <label
              htmlFor="project-port-range"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Port range (optional)
            </label>
            <input
              id="project-port-range"
              type="text"
              value={portRange}
              onChange={(e) => setPortRange(e.target.value)}
              placeholder="e.g. 4200-4299 — empty assigns one automatically"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleAdd();
                }
              }}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              This machine&apos;s starting assignment. A{" "}
              <code className="text-foreground">ports.range</code> later declared in the project
              config takes precedence.
            </p>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleAdd} disabled={loading || !path.trim()}>
            {loading && <Loader2 className="mr-1 size-4 animate-spin" />}
            Add Project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
