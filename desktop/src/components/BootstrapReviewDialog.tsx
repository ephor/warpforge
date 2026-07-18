import { AlertTriangle, Check, FileText, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

import { daemon } from "../daemon";

interface Issue {
  severity: "error" | "warning";
  message: string;
}

interface Props {
  project: string;
  agentText: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function BootstrapReviewDialog({
  project,
  agentText,
  open,
  onOpenChange,
}: Props) {
  const [yaml, setYaml] = useState("");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [writing, setWriting] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const res = (await daemon.request("bootstrap.finalize", {
          response: agentText,
        })) as { yaml: string; issues: Issue[] };
        if (!cancelled) {
          setYaml(res.yaml);
          setIssues(res.issues);
        }
      } catch (e) {
        if (!cancelled) {
          toast.error("Failed to parse agent output", {
            description: String(e),
          });
          onOpenChange(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, agentText, onOpenChange]);

  const hasErrors = issues.some((i) => i.severity === "error");

  const handleAccept = useCallback(async () => {
    setWriting(true);
    try {
      const res = (await daemon.request("bootstrap.writeConfig", {
        project,
        yaml,
      })) as { ok: boolean; path: string };
      if (res.ok) {
        toast.success("Config written", {
          description: res.path,
        });
        onOpenChange(false);
      }
    } catch (e) {
      toast.error("Failed to write config", {
        description: String(e),
      });
    } finally {
      setWriting(false);
    }
  }, [project, yaml, onOpenChange]);

  const handleDiscard = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="size-4" />
            Review Generated Config
          </DialogTitle>
          <DialogDescription>
            Agent generated a <code>.warpforge.yaml</code> for <strong>{project}</strong>.
            Review the config below before writing it to disk.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            Parsing agent output…
          </div>
        ) : (
          <>
            {issues.length > 0 && (
              <div className="flex flex-col gap-1">
                {issues.map((issue, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 rounded-md px-3 py-2 text-sm"
                    style={{
                      backgroundColor:
                        issue.severity === "error"
                          ? "hsl(var(--destructive) / 0.1)"
                          : "hsl(var(--chart-4) / 0.1)",
                    }}
                  >
                    <AlertTriangle
                      className="mt-0.5 size-3.5 shrink-0"
                      style={{
                        color:
                          issue.severity === "error"
                            ? "hsl(var(--destructive))"
                            : "hsl(var(--chart-4))",
                      }}
                    />
                    <span>{issue.message}</span>
                    <Badge
                      variant={issue.severity === "error" ? "destructive" : "outline"}
                      className="ml-auto shrink-0 text-xs"
                    >
                      {issue.severity}
                    </Badge>
                  </div>
                ))}
                <Separator className="mt-2" />
              </div>
            )}

            <ScrollArea className="h-[400px] rounded-md border">
              <pre className="p-4 font-mono text-sm whitespace-pre-wrap">{yaml}</pre>
            </ScrollArea>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleDiscard} disabled={writing}>
            <X className="mr-1 size-3.5" />
            Discard
          </Button>
          <Button onClick={handleAccept} disabled={loading || writing || hasErrors}>
            {writing ? (
              "Writing…"
            ) : (
              <>
                <Check className="mr-1 size-3.5" />
                Accept &amp; Write
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
