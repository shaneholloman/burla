import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { managementJson } from "@/lib/managementApi";
import { cn } from "@/lib/utils";

interface StructureNode {
    function_name: string;
    job_count: number;
    job_id: string | null;
    contains_current?: boolean;
    status_counts: Record<string, number>;
    input_count: number;
    result_count: number;
    cpu_per_call: number | string | null;
    ram_per_call: number | string | null;
    gpu_per_call: string | null;
    running_parallelism: number;
    children: StructureNode[];
}

interface TreeResponse {
    root: Omit<StructureNode, "children" | "status_counts" | "contains_current"> & {
        status: string;
    };
    groups: StructureNode[];
}

const STATUS_DOTS: { status: string; className: string; pulse?: boolean }[] = [
    { status: "running", className: "bg-sky-500", pulse: true },
    { status: "completed", className: "bg-emerald-500 dark:bg-emerald-400" },
    { status: "failed", className: "bg-destructive" },
    { status: "canceled", className: "bg-muted-foreground/60" },
];

const StatusDots = ({ counts }: { counts: Record<string, number> }) => (
    <span className="inline-flex items-center gap-2.5">
        {STATUS_DOTS.filter(({ status }) => counts[status]).map(({ status, className, pulse }) => (
            <span
                key={status}
                title={`${counts[status].toLocaleString()} ${status}`}
                className="inline-flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground"
            >
                <span className={cn("h-1.5 w-1.5 rounded-full", className, pulse && "animate-pulse")} />
                {counts[status].toLocaleString()}
            </span>
        ))}
    </span>
);

const perCallText = (node: StructureNode): string => {
    const part = (value: number | string | null, unit: string) => {
        if (value == null) return null;
        if (value === "dynamic") return `Dyn ${unit}`;
        if (value === "mixed") return `Mixed ${unit}`;
        return `${value} ${unit}`;
    };
    const parts = [part(node.cpu_per_call, "vCPU"), part(node.ram_per_call, "GB")];
    if (node.gpu_per_call) parts.push(String(node.gpu_per_call));
    return parts.filter(Boolean).join(" · ");
};

const NODE_W = 250;
const NODE_H = 98;
const GAP_X = 72;
const GAP_Y = 20;

interface LaidOutNode {
    node: StructureNode;
    depth: number;
    x: number;
    y: number;
    parent: LaidOutNode | null;
}

// Tidy tree layout: leaves stack top-to-bottom, parents center on their
// children. Deterministic, so polling re-renders never shift the layout
// unless the structure itself changed.
const layOutTree = (root: StructureNode): LaidOutNode[] => {
    const nodes: LaidOutNode[] = [];
    let nextLeafSlot = 0;
    const place = (node: StructureNode, depth: number, parent: LaidOutNode | null): LaidOutNode => {
        const laidOut: LaidOutNode = { node, depth, x: depth * (NODE_W + GAP_X), y: 0, parent };
        nodes.push(laidOut);
        if (node.children.length === 0) {
            laidOut.y = nextLeafSlot * (NODE_H + GAP_Y);
            nextLeafSlot += 1;
        } else {
            const childYs = node.children.map((child) => place(child, depth + 1, laidOut).y);
            laidOut.y = (Math.min(...childYs) + Math.max(...childYs)) / 2;
        }
        return laidOut;
    };
    place(root, 0, null);
    return nodes;
};

const GraphNodeCard = ({ laidOut, currentJobId }: { laidOut: LaidOutNode; currentJobId: string }) => {
    const { node, x, y } = laidOut;
    // The job whose page is showing: highlighted, not a link.
    const isCurrent = node.job_id === currentJobId || !!node.contains_current;
    const running = (node.status_counts["running"] ?? 0) > 0;
    const resources = perCallText(node);
    const body = (
        <>
            <div className="flex items-center gap-2">
                <span
                    title={node.function_name}
                    className="truncate font-mono text-[13px] font-medium text-foreground"
                >
                    {node.function_name}
                </span>
                {node.job_count > 1 && (
                    <span className="shrink-0 rounded-full border border-border bg-muted/60 px-1.5 py-[1px] text-[11px] font-medium tabular-nums text-muted-foreground">
                        ×{node.job_count.toLocaleString()}
                    </span>
                )}
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-[12px] tabular-nums text-foreground">
                    {node.result_count.toLocaleString()}
                    <span className="text-muted-foreground"> / {node.input_count.toLocaleString()} calls</span>
                </span>
                <StatusDots counts={node.status_counts} />
            </div>
            <div className="mt-1 truncate text-[11px] text-muted-foreground">
                {resources}
                {node.running_parallelism > 0 && (
                    <span className="text-sky-600 dark:text-sky-400">
                        {resources ? " · " : ""}up to {node.running_parallelism.toLocaleString()} in flight
                    </span>
                )}
            </div>
        </>
    );
    const className = cn(
        "absolute rounded-lg border bg-card px-3.5 py-2.5 shadow-sm transition-colors",
        isCurrent ? "border-primary ring-1 ring-primary/30" : "border-border",
        running && !isCurrent && "ring-1 ring-sky-500/20",
        node.job_id && !isCurrent && "cursor-pointer hover:border-primary/60"
    );
    const style = { left: x, top: y, width: NODE_W, height: NODE_H };
    if (node.job_id && !isCurrent) {
        return (
            <Link to={`/jobs/${node.job_id}`} className={className} style={style}>
                {body}
            </Link>
        );
    }
    return (
        <div className={className} style={style} title={node.job_count > 1 ? `${node.job_count} jobs` : undefined}>
            {body}
        </div>
    );
};

const StructureGraph = ({ root, currentJobId }: { root: StructureNode; currentJobId: string }) => {
    const laidOutNodes = useMemo(() => layOutTree(root), [root]);
    const width = (Math.max(...laidOutNodes.map((n) => n.depth)) + 1) * (NODE_W + GAP_X) - GAP_X;
    const height = Math.max(...laidOutNodes.map((n) => n.y)) + NODE_H;
    return (
        <div className="overflow-x-auto rounded-xl border border-border bg-card p-6 shadow-sm">
            <div
                className="relative"
                style={{
                    width,
                    height,
                    backgroundImage: "radial-gradient(hsl(var(--border)) 1px, transparent 1px)",
                    backgroundSize: "22px 22px",
                }}
            >
                <svg width={width} height={height} className="absolute inset-0">
                    {laidOutNodes
                        .filter((n) => n.parent)
                        .map((n) => {
                            const from = { x: n.parent!.x + NODE_W, y: n.parent!.y + NODE_H / 2 };
                            const to = { x: n.x, y: n.y + NODE_H / 2 };
                            const midX = (from.x + to.x) / 2;
                            return (
                                <path
                                    key={`${n.depth}-${n.node.function_name}-${n.y}`}
                                    d={`M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`}
                                    fill="none"
                                    className="stroke-muted-foreground/40"
                                    strokeWidth={1.5}
                                />
                            );
                        })}
                </svg>
                {laidOutNodes.map((n) => (
                    <GraphNodeCard
                        key={`${n.depth}-${n.node.function_name}-${n.y}`}
                        laidOut={n}
                        currentJobId={currentJobId}
                    />
                ))}
            </div>
        </div>
    );
};

const hasLiveJobs = (node: StructureNode): boolean =>
    ["running", "pending"].some((status) => node.status_counts[status]) ||
    node.children.some(hasLiveJobs);

// The graph of the whole nested workload this job belongs to (always the full
// graph from the outermost root, whichever member job's page is showing, so
// clicking around the workload keeps the graph in place). Renders nothing for
// jobs with no nested structure.
export const JobStructure = ({ jobId }: { jobId: string }) => {
    const [tree, setTree] = useState<TreeResponse | null>(null);

    const root: StructureNode | null = useMemo(() => {
        if (!tree) return null;
        return {
            ...tree.root,
            status_counts: { [tree.root.status]: 1 } as Record<string, number>,
            children: tree.groups,
        } as StructureNode;
    }, [tree]);

    const isLive = root == null || hasLiveJobs(root);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const data = await managementJson<TreeResponse>(`/jobs/${jobId}/tree`);
                if (!cancelled) setTree(data);
            } catch (err) {
                console.error("Error fetching job tree:", err);
            }
        };
        load();
        if (!isLive) return;
        const id = window.setInterval(load, 3000);
        return () => {
            cancelled = true;
            window.clearInterval(id);
        };
    }, [jobId, isLive]);

    if (!root || root.children.length === 0) return null;

    return (
        <div className="mb-4">
            <h2 className="mb-2 text-sm font-semibold text-foreground">Workload</h2>
            <StructureGraph root={root} currentJobId={jobId} />
        </div>
    );
};
